/**
 * SPIKE — not wired into the production boot path. See docs/performance.md
 * item 1(b)/(c): move the virtio-i2c bridge into a worker so it can block on
 * `Atomics.wait` instead of a paced `setTimeout`/`MessagePort` poll, and pair
 * it with a QEMU-side `__builtin_wasm_memory_atomic_notify` on `req_wr`
 * (tools/qemu-jit-patches/0018-notify-req-wr-atomic.patch) so the wake is a
 * real wakeup rather than the worker's own poll timeout.
 *
 * Scope, deliberately narrow for a first measurement: only the "i2c" device,
 * only the MCP4725 DAC chip. transport.ts's actual multi-bridge, multi-model
 * machinery (reset generations across many devices, config-space writes, the
 * outbox retry path for a full ring) is not reproduced in full here — this
 * answers one question (is the round trip actually sub-millisecond with this
 * mechanism?), not "is this production-ready." See
 * src/virtio/spike/attachAtomicsSpike.ts for what a real port would still
 * need: every other device model, and specifically the ones with real DOM
 * dependencies (localStorage-backed EEPROM/flash persistence, live device-
 * motion sensors) that cannot simply move into a worker unchanged.
 *
 * Completions still go through `_qemu_virtio_browser_kick()` on the main
 * thread (posted back here) rather than a symmetric wasm-memory-notify from
 * this side: that export's job is `qemu_bh_schedule` under the BQL, a
 * QEMU-internal call that has nowhere clean to land from a worker that never
 * instantiated the module. See docs/performance.md for why that is the
 * asymmetry and not an oversight.
 *
 * Shutdown is `worker.terminate()` from the main thread, not a `stop`
 * message: once `loop()` is running it never returns to the event loop
 * except inside `Atomics.wait` itself, so a posted message would not be
 * dispatched until the *next* wait's timeout fires anyway. A real port would
 * check a shared "stop" flag (a reserved word in the same SharedArrayBuffer)
 * each time a wait returns, whether by notify or by timeout, rather than
 * rely on the message queue at all.
 */

import {
  AREA,
  AREA_MAGIC,
  AREA_VERSION,
  CMP_FAIL,
  CMP_OK,
  drainRequests,
  readName,
  writeCompletion,
} from '../protocol'
import { createI2cModel } from '../devices/i2c'
import { createMcp4725 } from '../devices/chips/mcp4725'
import type { VirtioRequest } from '../transport'

export type MainToWorker =
  | {
      type: 'init'
      buffer: ArrayBufferLike
      areaBase: number
      /** Int32-index of the completion wake word, or -1 when unavailable. */
      wakeWordIndex: number
    }
  | { type: 'stop' }

export type WorkerToMain =
  | { type: 'ready'; workerNow: number }
  | { type: 'kick'; postedAt: number }
  | { type: 'stats'; requests: number; wallMs: number; waitWakes: number; waitTimeouts: number }
  | { type: 'fatal'; message: string }

const post = (message: WorkerToMain) => {
  ;(self as unknown as { postMessage(message: WorkerToMain): void }).postMessage(message)
}

/** No real wakeup should ever take this long; it's a liveness check, not the wake path. */
const WAIT_TIMEOUT_MS = 50
const STATS_EVERY_MS = 500

let running = false
let words: Int32Array | null = null
let view: DataView | null = null
let heap: Uint8Array | null = null

let areaBase = 0
let reqBase = 0
let reqSize = 0
let cmpBase = 0
let cmpSize = 0
let reqWrIndex = 0
let wakeWordIndex = -1

let reqRd = 0
let cmpWr = 0
let resetGenSeen = 0
const outbox: Array<{ token: number; flags: number; payload: Uint8Array | null }> = []
const pending = new Map<number, VirtioRequest>()

let requestsSeen = 0
let waitWakes = 0
let waitTimeouts = 0
let statsAt = 0

const i2cModel = createI2cModel('i2c')
i2cModel.attachChip(createMcp4725({ address: 0x61 }))

function load(byteOffset: number): number {
  return Atomics.load(words!, byteOffset >> 2) >>> 0
}

function store(byteOffset: number, value: number) {
  Atomics.store(words!, byteOffset >> 2, value | 0)
}

function flush() {
  let published = 0
  while (outbox.length) {
    const next = outbox[0]
    const rd = load(areaBase + AREA.cmpRd)
    const wr = writeCompletion(heap!, view!, cmpBase, cmpSize, cmpWr, rd, next.token, next.flags, next.payload)
    if (wr === null) break // full; retry next tick
    cmpWr = wr
    store(areaBase + AREA.cmpWr, wr)
    outbox.shift()
    published++
  }
  if (published) wakeQemu()
}

function wakeQemu() {
  if (words && wakeWordIndex >= 0) {
    Atomics.add(words, wakeWordIndex, 1)
    Atomics.notify(words, wakeWordIndex)
  }
  // The BQL-scheduling half of the wake (qemu_bh_schedule) has to run through
  // the real Emscripten export, which only the main thread holds a working
  // reference to.
  post({ type: 'kick', postedAt: performance.now() })
}

function makeRequest(token: number, queue: number, out: Uint8Array, inCap: number): VirtioRequest {
  let answered = false
  const req: VirtioRequest = {
    queue,
    out,
    inCap,
    get answered() {
      return answered
    },
    reply(bytes) {
      if (answered) return
      answered = true
      pending.delete(token)
      outbox.push({ token, flags: CMP_OK, payload: bytes ?? null })
      flush()
    },
    fail() {
      if (answered) return
      answered = true
      pending.delete(token)
      outbox.push({ token, flags: CMP_FAIL, payload: null })
      flush()
    },
    park() {
      /* Not exercised by the DAC path this spike targets. */
    },
  }
  pending.set(token, req)
  return req
}

function drainOnce() {
  const resetGen = load(areaBase + AREA.resetGen)
  if (resetGen !== resetGenSeen) {
    resetGenSeen = resetGen
    outbox.length = 0
    pending.clear()
    i2cModel.reset?.()
  }

  flush()

  const wr = load(areaBase + AREA.reqWr)
  if (wr === reqRd) return
  reqRd = drainRequests(heap!, view!, reqBase, reqSize, reqRd, wr, ({ token, queue, out, inCap }) => {
    requestsSeen += 1
    const req = makeRequest(token, queue, out.slice(), inCap)
    try {
      i2cModel.handle(req)
    } catch (err) {
      console.error('[virtio-spike] i2c model threw; failing the chain', err)
      req.fail()
    }
  })
  store(areaBase + AREA.reqRd, reqRd)
}

function loop() {
  while (running) {
    drainOnce()

    const now = performance.now()
    if (now - statsAt >= STATS_EVERY_MS) {
      post({ type: 'stats', requests: requestsSeen, wallMs: now, waitWakes, waitTimeouts })
      statsAt = now
    }

    const seen = load(areaBase + AREA.reqWr)
    const result = Atomics.wait(words!, reqWrIndex, seen | 0, WAIT_TIMEOUT_MS)
    if (result === 'timed-out') waitTimeouts += 1
    else waitWakes += 1
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as MainToWorker
  if (message.type === 'init') {
    try {
      const buffer = message.buffer
      words = new Int32Array(buffer)
      view = new DataView(buffer)
      heap = new Uint8Array(buffer)
      areaBase = message.areaBase
      wakeWordIndex = message.wakeWordIndex

      if (view.getUint32(areaBase + AREA.magic, true) !== AREA_MAGIC) {
        post({ type: 'fatal', message: 'bad area magic' })
        return
      }
      if (view.getUint32(areaBase + AREA.version, true) !== AREA_VERSION) {
        post({ type: 'fatal', message: 'protocol version mismatch' })
        return
      }
      const name = readName(heap, areaBase)
      if (name !== 'i2c') {
        post({ type: 'fatal', message: `expected device "i2c", area names itself "${name}"` })
        return
      }

      reqBase = areaBase + view.getUint32(areaBase + AREA.reqOff, true)
      reqSize = view.getUint32(areaBase + AREA.reqSize, true)
      cmpBase = areaBase + view.getUint32(areaBase + AREA.cmpOff, true)
      cmpSize = view.getUint32(areaBase + AREA.cmpSize, true)
      reqWrIndex = (areaBase + AREA.reqWr) >> 2
      reqRd = load(areaBase + AREA.reqRd)
      cmpWr = load(areaBase + AREA.cmpWr)
      resetGenSeen = load(areaBase + AREA.resetGen)
      statsAt = performance.now()

      running = true
      post({ type: 'ready', workerNow: performance.now() })
      loop()
    } catch (err) {
      post({ type: 'fatal', message: err instanceof Error ? err.message : String(err) })
    }
  } else if (message.type === 'stop') {
    running = false
  }
})
