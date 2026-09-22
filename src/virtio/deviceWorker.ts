/**
 * Device execution, off the presentation thread.
 *
 * This worker owns QEMU's request futex and drains the bridges routed to it by
 * `transport.ts`. It answers requests, publishes completions, and retains the
 * samples a model produces, sending the main thread one batch per frame rather
 * than one notification per event.
 *
 * Why this exists, precisely: the guest *blocks* on a browser answer
 * (`k_sem_take(..., K_FOREVER)`), so the page's scheduling is the guest's
 * scheduling. With the drain on the main thread, a long React commit is a long
 * guest stall. Measuring that was the point of `MAX_REQUESTS_PER_POLL` in
 * `bridgeCore.ts`: gpio-7-segment multiplexing at 1 ms, drained on the main
 * thread, left the console pty blank while the guest kept talking.
 *
 * Note that this is not a throughput change and was never expected to be one.
 * Earlier experiments moving models off the main thread recorded no gain with
 * the page otherwise idle, which is what you would expect: the work is the same
 * work. What changes is the tail, when something else is competing for the
 * thread.
 *
 * Two things it cannot do, both because they are wasm exports that only exist
 * where the Module lives:
 *
 * - **Discover devices.** The main thread enumerates and sends area base
 *   addresses, which are plain offsets into the heap we share.
 * - **Kick QEMU.** We publish the completion ourselves, then ask the main
 *   thread to schedule the drain BH. A late kick is not a late completion: the
 *   record is already in the ring, and QEMU rearms its realtime drain at 1 ms
 *   whenever a token is outstanding, which is exactly when a guest is waiting.
 *
 * It waits with `Atomics.waitAsync` rather than `Atomics.wait`, because a
 * worker blocked in `Atomics.wait` cannot receive messages, and this one has to
 * stay reachable for GPIO input and rebinds. `src/display/renderWorker.ts` uses
 * the same primitive on the frame sequence.
 */

import type { VirtioDeviceModel } from './bridgeCore'
import { createBridgeCore } from './bridgeCore'
import type { BridgeCore } from './bridgeCore'
import { AREA } from './protocol'
import { createGpioModel } from './devices/gpio'
import type { GpioBatch, GpioInputRequest } from './devices/gpioProtocol'
import { GPIO_EDGE_CAPACITY } from './devices/gpioProtocol'
import { createGpioEdgeRecorder } from './devices/gpioEdges'

export type MainToDeviceWorker =
  | { type: 'start'; buffer: SharedArrayBuffer; wordIndex: number; expected: number }
  | { type: 'bind'; areaBase: number; name: string }
  | { type: 'mainAreas'; areas: number[] }
  | { type: 'device'; name: string; payload: unknown }

export type DeviceWorkerToMain =
  /** A main-thread-owned area has an unread request. */
  | { type: 'wake'; count: number }
  /** Completions are published; please call the kick export. */
  | { type: 'kick'; requests: number; kicks: number }
  | { type: 'bound'; name: string }
  | { type: 'device'; name: string; payload: unknown }
  | { type: 'fatal'; message: string }

// DOM lib types `self` as Window in this project. Keep the worker surface
// narrow instead of pulling WebWorker globals into the whole application.
const workerSelf = self as unknown as {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MainToDeviceWorker>) => void,
  ): void
  postMessage(message: DeviceWorkerToMain, transfer?: Transferable[]): void
}

type AtomicsWithWaitAsync = typeof Atomics & {
  waitAsync?: (
    typedArray: Int32Array,
    index: number,
    value: number,
  ) => { async: false; value: 'not-equal' | 'timed-out' } | { async: true; value: Promise<string> }
}

function post(message: DeviceWorkerToMain, transfer?: Transferable[]) {
  workerSelf.postMessage(message, transfer)
}

let heap: Uint8Array | null = null
let words: Int32Array | null = null
let core: BridgeCore | null = null
let wakeIndex = 0
let expected = 0
/** Areas the main thread drains. We only interrupt it when one has work. */
let mainAreas: number[] = []
/** A kick is owed to the main thread; coalesced to one per drain batch. */
let kickPending = false

/* --- GPIO sample retention ------------------------------------------------
 * The seven-segment latch on the main thread reconstructs a multiplexed
 * display, so it needs every output word, not the latest one: Zephyr's driver
 * lights one digit at a time and the page would otherwise only ever see one
 * frame of the scan. The SCT2024 LED chip latches on a GPIO pin edge for the
 * same reason. So the edges are retained here, in order, and shipped as a batch
 * that the main thread replays.
 *
 * The ring is sized for roughly twenty frames of a 1 ms multiplex. Overflow is
 * a correctness question rather than a performance one: a dropped edge is a
 * wrong digit, not a late one, so it is counted and reported rather than
 * silently absorbed.
 */
const gpioModel = createGpioModel('gpio')
const gpioEdges = createGpioEdgeRecorder(GPIO_EDGE_CAPACITY)
let gpioBound = false
let flushTimer: ReturnType<typeof setTimeout> | 0 = 0

/** One frame. Workers have no rAF, and the main thread coalesces to rAF anyway. */
const FLUSH_MS = 16

function recordGpioEdge() {
  gpioEdges.record(gpioModel.getOutputs())
  scheduleFlush()
}

function scheduleFlush() {
  if (flushTimer || !gpioBound) return
  flushTimer = setTimeout(flushGpio, FLUSH_MS)
}

function flushGpio() {
  flushTimer = 0
  if (!gpioBound) return
  const ngpio = gpioModel.ngpio
  const directions = new Uint8Array(ngpio)
  for (let i = 0; i < ngpio; i++) {
    const d = gpioModel.getDirection(i)
    directions[i] = d === 'in' ? 2 : d === 'out' ? 1 : 0
  }
  const taken = gpioEdges.take()
  const batch: GpioBatch = {
    edges: taken.edges,
    dropped: taken.dropped,
    inputs: gpioModel.getInputs(),
    outputs: gpioModel.getOutputs(),
    ngpio,
    directions,
  }
  post({ type: 'device', name: 'gpio', payload: batch }, [
    batch.edges.buffer,
    batch.directions.buffer,
  ])
}

function modelFor(name: string): VirtioDeviceModel | null {
  if (name === 'gpio') {
    if (!gpioBound) {
      gpioBound = true
      gpioModel.subscribe(recordGpioEdge)
    }
    return gpioModel
  }
  return null
}

function onDeviceMessage(name: string, payload: unknown) {
  if (name !== 'gpio') return
  const message = payload as GpioInputRequest
  if (message?.type === 'inputs') gpioModel.setInputs(message.mask)
}

/* --- the drain ------------------------------------------------------------ */

/** Whether an area the main thread owns has a request it has not read. */
function mainHasWork(): boolean {
  if (!words || !mainAreas.length) return false
  for (const areaBase of mainAreas) {
    const wr = Atomics.load(words, (areaBase + AREA.reqWr) >> 2) >>> 0
    const rd = Atomics.load(words, (areaBase + AREA.reqRd) >> 2) >>> 0
    if (wr !== rd) return true
  }
  return false
}

function drain(count: number) {
  if (!core) return
  // Our own bridges first: this is the whole reason the worker exists, and it
  // must not queue behind a message hop to a thread that may be rendering.
  let backlog = true
  // Bounded so a flood cannot starve the message queue that feeds us input.
  for (let i = 0; i < 8 && backlog; i++) {
    backlog = core.poll(performance.now())
  }
  if (kickPending) {
    kickPending = false
    post({ type: 'kick', requests: core.stats.requests, kicks: core.stats.kicks })
  }
  if (backlog) setTimeout(() => drain(0), 0)
  // Only now, and only if it actually has something to do.
  if (count > 0 && mainHasWork()) post({ type: 'wake', count })
}

function waitLoop() {
  const waitAsync = (Atomics as AtomicsWithWaitAsync).waitAsync
  if (!words || !waitAsync) {
    post({ type: 'fatal', message: 'Atomics.waitAsync is unavailable in this worker' })
    return
  }

  const step = () => {
    if (!words) return
    const result = waitAsync.call(Atomics, words, wakeIndex, expected)
    const resume = () => {
      const current = Atomics.load(words!, wakeIndex)
      if (current === expected) {
        // Spurious, or a value that came back around. Nothing published.
        step()
        return
      }
      const count = (current - expected) >>> 0
      expected = current
      try {
        drain(count)
      } catch (err) {
        console.error('[virtio/worker] drain failed; the bridge keeps running', err)
      }
      step()
    }
    if (result.async) void result.value.then(resume, resume)
    else resume()
  }
  step()
}

function start(message: Extract<MainToDeviceWorker, { type: 'start' }>) {
  const { buffer, wordIndex } = message
  if (
    !Number.isInteger(wordIndex) ||
    wordIndex < 0 ||
    wordIndex >= buffer.byteLength / Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(`invalid request futex index ${wordIndex}`)
  }
  heap = new Uint8Array(buffer)
  words = new Int32Array(buffer)
  wakeIndex = wordIndex
  expected = message.expected | 0
  core = createBridgeCore({
    heap,
    // Coalesced into one message per drain batch rather than posted here: a
    // multi-message transfer answers several requests in one poll, and QEMU
    // finishes them in one BH either way.
    wake: () => {
      kickPending = true
    },
  })
  waitLoop()
}

workerSelf.addEventListener('message', (event) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'start':
        start(message)
        break
      case 'bind': {
        const model = modelFor(message.name)
        if (!model) {
          post({ type: 'fatal', message: `no worker-side model for "${message.name}"` })
          return
        }
        if (core?.bind(message.areaBase, model)) {
          post({ type: 'bound', name: message.name })
          // The guest may already have published before we bound.
          drain(0)
          scheduleFlush()
        }
        break
      }
      case 'mainAreas':
        mainAreas = message.areas
        break
      case 'device':
        onDeviceMessage(message.name, message.payload)
        break
    }
  } catch (error) {
    post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
  }
})
