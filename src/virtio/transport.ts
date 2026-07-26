/**
 * Browser side of the generic virtio bridge; QEMU hands descriptor chains here
 * as flat requests. See docs/virtio-bridge.md for the shared-memory contract.
 * Devices bind by `name=`, not index or device id.
 * Completions publish `cmp_wr`, Atomics.notify a shared wake word, then kick a
 * QEMU BH to drain under the BQL; old/non-shared builds fall back to polling.
 * Request detection can use an Atomics.wait worker, while device models stay on
 * this thread for browser-only state.
 */

import {
  AREA,
  AREA_MAGIC,
  AREA_VERSION,
  CMP_FAIL,
  CMP_OK,
  CONFIG_MAX,
  drainRequests,
  readName,
  writeCompletion,
} from './protocol'
import type {
  MainToRequestWaiter,
  RequestWaiterToMain,
} from './requestWaitWorker'

interface BridgeExports {
  _qemu_virtio_browser_count?: () => number
  _qemu_virtio_browser_area?: (index: number) => number
  _qemu_virtio_browser_wake_addr?: () => number
  _qemu_virtio_browser_request_wake_addr?: () => number
  /** Schedule completion drain on QEMU's thread; do not drain inline. */
  _qemu_virtio_browser_kick?: () => void
  _qemu_virtio_wake_avg_ns?: () => number
  _qemu_virtio_wake_max_ns?: () => number
  _qemu_virtio_wake_count?: () => number
  _qemu_virtio_notify_via_kick_count?: () => number
  _qemu_virtio_notify_via_timer_count?: () => number
  HEAPU8?: Uint8Array
}

export interface WakeLatencyStats {
  avgNs: number
  maxNs: number
  count: number
}

export function wakeLatencyStats(): WakeLatencyStats | null {
  if (!exports?._qemu_virtio_wake_avg_ns) return null
  return {
    avgNs: exports._qemu_virtio_wake_avg_ns(),
    maxNs: exports._qemu_virtio_wake_max_ns?.() ?? -1,
    count: exports._qemu_virtio_wake_count?.() ?? 0,
  }
}

export interface NotifySourceStats {
  viaKick: number
  viaTimer: number
}

export function notifySourceStats(): NotifySourceStats | null {
  if (!exports?._qemu_virtio_notify_via_kick_count) return null
  return {
    viaKick: exports._qemu_virtio_notify_via_kick_count(),
    viaTimer: exports._qemu_virtio_notify_via_timer_count?.() ?? 0,
  }
}

export interface VirtioRequest {
  readonly queue: number
  /** Copy of the device-readable bytes; safe for parked requests. */
  readonly out: Uint8Array
  readonly inCap: number
  reply(bytes?: Uint8Array | null): void
  fail(): void
  /** Deliberately held chains must park to waive the watchdog. */
  park(): void
  readonly answered: boolean
}

export interface VirtioDeviceModel {
  readonly name: string
  handle(req: VirtioRequest): void
  /** Guest reset: drop parked state; stale answers will be discarded. */
  reset?(): void
  /** Mutate config space, then call `notify` to raise a config-change interrupt. */
  attachConfig?(config: Uint8Array, notify: () => void): void
}

const IDLE_MS = 50
const HOT_WINDOW_MS = 100
/** Prevent the MessageChannel hot path from busy-looping the main thread. */
const HOT_PERIOD_MS = 1
/**
 * Catches leaked chains without tripping on intentionally parked requests.
 */
const WATCHDOG_MS = 5000

interface Pending {
  req: VirtioRequest
  at: number
  parked: boolean
}

interface Bridge {
  name: string
  deviceId: number
  numQueues: number
  areaBase: number
  reqBase: number
  reqSize: number
  cmpBase: number
  cmpSize: number
  model: VirtioDeviceModel
  /** Page-owned indices; QEMU owns req_wr/cmp_rd. */
  reqRd: number
  cmpWr: number
  resetGen: number
  outbox: Array<{ token: number; flags: number; payload: Uint8Array | null }>
  pending: Map<number, Pending>
}

const models = new Map<string, VirtioDeviceModel>()
const bindListeners = new Set<() => void>()

let exports: BridgeExports | null = null
let heap: Uint8Array | null = null
let view: DataView | null = null
let words: Int32Array | null = null
let bridges: Bridge[] = []
let timer: ReturnType<typeof setTimeout> | 0 = 0
let scheduled = false
let hotUntil = 0
let nextHotAt = 0
let requestWaiter: Worker | null = null
let requestWaiterReady = false

/* --- instrumentation ------------------------------------------------------
 * Free-running counters; readers diff two samples.
 */

export interface BridgeStats {
  hotPolls: number
  hotGapMsSum: number
  hotPollsSlow: number
  requests: number
  kicks: number
  waiterWakeups: number
  waiterActive: boolean
}

/** Hot polls slower than this are missing their requested pace. */
const HOT_GAP_SLOW_MS = 2

let hotPolls = 0
let hotGapMsSum = 0
let hotPollsSlow = 0
let requestsSeen = 0
let kicksSeen = 0
let waiterWakeupsSeen = 0
let lastHotPollAt = 0
let wakeWordIndex = -1

export function stats(): BridgeStats {
  return {
    hotPolls,
    hotGapMsSum,
    hotPollsSlow,
    requests: requestsSeen,
    kicks: kicksSeen,
    waiterWakeups: waiterWakeupsSeen,
    waiterActive: requestWaiterReady,
  }
}

const hotChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null
hotChannel?.port1.addEventListener('message', (ev) => hotWakeup((ev as MessageEvent).data))
hotChannel?.port1.start()

/**
 * Message tasks avoid timer clamping and reset timer nesting before 1 ms polls.
 * Stale messages after detach are harmless because poll clears scheduling state.
 */
function hotWakeup(delay: unknown) {
  if (typeof delay !== 'number' || delay <= 0 || !exports) {
    poll()
    return
  }
  timer = setTimeout(poll, delay)
}

function stopRequestWaiter() {
  requestWaiter?.terminate()
  requestWaiter = null
  requestWaiterReady = false
}

function pollFromRequestWake() {
  if (!exports) return
  if (timer) clearTimeout(timer)
  timer = 0
  scheduled = false
  nextHotAt = 0
  poll()
}

function fallBackFromRequestWaiter(message: string) {
  if (!requestWaiter) return
  console.warn(`[virtio] atomic request waiter stopped (${message}); using timer polling`)
  stopRequestWaiter()
  hotUntil = performance.now() + HOT_WINDOW_MS
  pollFromRequestWake()
}

function dispatchRequestWake(count: number) {
  waiterWakeupsSeen += count
  pollFromRequestWake()
}

/** Start the request futex waiter when the emulator and heap support it. */
function startRequestWaiter() {
  const h = exports?.HEAPU8
  const requestWakeAddr = exports?._qemu_virtio_browser_request_wake_addr?.()
  if (
    !h ||
    typeof SharedArrayBuffer === 'undefined' ||
    !(h.buffer instanceof SharedArrayBuffer) ||
    typeof Worker !== 'function' ||
    typeof requestWakeAddr !== 'number' ||
    requestWakeAddr <= 0 ||
    (requestWakeAddr & 3) !== 0 ||
    requestWakeAddr >= h.buffer.byteLength
  ) {
    return
  }

  try {
    const wordIndex = requestWakeAddr >> 2
    const expected = Atomics.load(new Int32Array(h.buffer), wordIndex)
    const worker = new Worker(new URL('./requestWaitWorker.ts', import.meta.url), {
      type: 'module',
    })
    requestWaiter = worker
    worker.onmessage = (event: MessageEvent<RequestWaiterToMain>) => {
      const message = event.data
      if (message.type === 'ready') {
        requestWaiterReady = true
      } else if (message.type === 'wake') {
        dispatchRequestWake(message.count)
      } else {
        fallBackFromRequestWaiter(message.message)
      }
    }
    worker.onerror = (event) => {
      fallBackFromRequestWaiter(event.message || 'worker error')
    }
    const message: MainToRequestWaiter = {
      type: 'start',
      buffer: h.buffer,
      wordIndex,
      expected,
    }
    worker.postMessage(message)
  } catch (error) {
    stopRequestWaiter()
    console.warn(
      '[virtio] could not start atomic request waiter; using timer polling',
      error,
    )
  }
}

export function register(model: VirtioDeviceModel) {
  models.set(model.name, model)
}

export function attach(mod: unknown) {
  detach()
  exports = mod as BridgeExports
  // The wake futex is process-lifetime; device areas may appear after machine init.
  const wakeAddr = exports._qemu_virtio_browser_wake_addr?.()
  wakeWordIndex =
    typeof wakeAddr === 'number' && wakeAddr > 0 && (wakeAddr & 3) === 0 ? wakeAddr >> 2 : -1
  startRequestWaiter()
  // Device discovery can run before machine init, so let the poll loop rescan.
  schedule(0)
}

export function detach() {
  stopRequestWaiter()
  if (timer) clearTimeout(timer)
  timer = 0
  scheduled = false
  hotUntil = 0
  lastHotPollAt = 0
  wakeWordIndex = -1
  const had = bridges.length
  bridges = []
  exports = null
  heap = null
  view = null
  words = null
  if (had) notifyBinds()
}

export function available(): boolean {
  return bridges.length > 0
}

export function boundNames(): string[] {
  return bridges.map((b) => b.name)
}

export function isBound(name: string): boolean {
  return bridges.some((b) => b.name === name)
}

export function subscribeBinds(fn: () => void): () => void {
  bindListeners.add(fn)
  return () => bindListeners.delete(fn)
}

function notifyBinds() {
  for (const fn of bindListeners) fn()
}

/* --- index words ----------------------------------------------------------
 * Each is written by exactly one side, but both sides read them, so they go
 * through Atomics: the release/acquire pairing with QEMU's
 * qatomic_store_release/load_acquire is what makes "the record is whole before
 * the index moves" true rather than merely likely. Atomics work on a plain
 * ArrayBuffer too (ES2020), so the test fake needs no special casing.
 */

function load(byteOffset: number): number {
  return Atomics.load(words!, byteOffset >> 2) >>> 0
}

function store(byteOffset: number, value: number) {
  Atomics.store(words!, byteOffset >> 2, value | 0)
}

/* --- discovery ------------------------------------------------------------ */

function rescan() {
  const before = bridges.length
  rescanInner()
  if (bridges.length !== before) notifyBinds()
}

function rescanInner() {
  const count = exports?._qemu_virtio_browser_count?.() ?? 0
  if (!count || !exports?._qemu_virtio_browser_area) return

  const h = exports.HEAPU8
  if (!h) return
  heap = h
  view = new DataView(h.buffer)
  words = new Int32Array(h.buffer)

  for (let i = 0; i < count; i++) {
    const areaBase = exports._qemu_virtio_browser_area(i)
    if (!areaBase) continue
    if (view.getUint32(areaBase + AREA.magic, true) !== AREA_MAGIC) {
      console.warn('[virtio] area', i, 'has a bad magic; ignoring')
      continue
    }
    const version = view.getUint32(areaBase + AREA.version, true)
    if (version !== AREA_VERSION) {
      console.warn(
        `[virtio] area ${i} speaks protocol v${version}, this page speaks ` +
          `v${AREA_VERSION}; ignoring. Rebuild the emulator.`,
      )
      continue
    }

    const name = readName(heap, areaBase)
    if (bridges.some((b) => b.areaBase === areaBase)) continue
    const model = models.get(name)
    if (!model) {
      console.warn(`[virtio] no model registered for device "${name}"`)
      continue
    }

    const bridge: Bridge = {
      name,
      deviceId: view.getUint32(areaBase + AREA.deviceId, true),
      numQueues: view.getUint32(areaBase + AREA.numQueues, true),
      areaBase,
      reqBase: areaBase + view.getUint32(areaBase + AREA.reqOff, true),
      reqSize: view.getUint32(areaBase + AREA.reqSize, true),
      cmpBase: areaBase + view.getUint32(areaBase + AREA.cmpOff, true),
      cmpSize: view.getUint32(areaBase + AREA.cmpSize, true),
      model,
      // Resume from req_rd, not req_wr: unanswered chains may still block guests.
      reqRd: load(areaBase + AREA.reqRd),
      cmpWr: load(areaBase + AREA.cmpWr),
      resetGen: load(areaBase + AREA.resetGen),
      outbox: [],
      pending: new Map(),
    }
    bridges.push(bridge)

    model.attachConfig?.(
      heap.subarray(areaBase + AREA.config, areaBase + AREA.config + CONFIG_MAX),
      () => store(areaBase + AREA.configGen, load(areaBase + AREA.configGen) + 1),
    )
  }
}

/* --- the loop ------------------------------------------------------------- */

function enqueue(b: Bridge, token: number, flags: number, payload: Uint8Array | null) {
  b.outbox.push({ token, flags, payload })
  flush(b)
  hotUntil = performance.now() + HOT_WINDOW_MS
}

function flush(b: Bridge) {
  // Parked requests may answer after detach.
  if (!heap || !view || !words) return
  let published = 0
  while (b.outbox.length) {
    const next = b.outbox[0]
    const rd = load(b.areaBase + AREA.cmpRd)
    const wr = writeCompletion(
      heap!,
      view!,
      b.cmpBase,
      b.cmpSize,
      b.cmpWr,
      rd,
      next.token,
      next.flags,
      next.payload,
    )
    if (wr === null) {
      if (published) wakeQemu()
      return // full; retry next tick
    }
    b.cmpWr = wr
    // Publish only after writing the whole completion record.
    store(b.areaBase + AREA.cmpWr, wr)
    b.outbox.shift()
    published++
  }
  if (published) wakeQemu()
}

/**
 * Wake QEMU after publishing cmp_wr. Atomics.notify covers futex waiters; kick
 * schedules BQL-held drain on QEMU's thread and must not drain inline here.
 * Missing exports are compatible: the periodic drain timer remains the path.
 */
function wakeQemu() {
  kicksSeen += 1
  if (words && wakeWordIndex >= 0) {
    Atomics.add(words, wakeWordIndex, 1)
    Atomics.notify(words, wakeWordIndex)
  }
  try {
    exports?._qemu_virtio_browser_kick?.()
  } catch (err) {
    // Do not let a failed kick abort the reply and strand the guest.
    console.error('[virtio] kick failed; drain timer will retry', err)
  }
}

function makeRequest(
  b: Bridge,
  token: number,
  queue: number,
  out: Uint8Array,
  inCap: number,
  now: number,
): VirtioRequest {
  let answered = false
  const entry: Pending = { req: null as unknown as VirtioRequest, at: now, parked: false }
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
      b.pending.delete(token)
      enqueue(b, token, CMP_OK, bytes ?? null)
    },
    fail() {
      if (answered) return
      answered = true
      b.pending.delete(token)
      enqueue(b, token, CMP_FAIL, null)
    },
    park() {
      entry.parked = true
    },
  }
  entry.req = req
  b.pending.set(token, entry)
  return req
}

function pollBridge(b: Bridge, now: number) {
  // Reset must not rewind reqRd: QEMU does not rewind req_wr, and skipping ahead
  // can strand guest threads. Stale replies are generation-checked and dropped.
  const resetGen = load(b.areaBase + AREA.resetGen)
  if (resetGen !== b.resetGen) {
    b.resetGen = resetGen
    b.outbox = []
    b.pending.clear()
    b.model.reset?.()
  }

  flush(b)

  const wr = load(b.areaBase + AREA.reqWr)
  if (wr !== b.reqRd) {
    b.reqRd = drainRequests(
      heap!,
      view!,
      b.reqBase,
      b.reqSize,
      b.reqRd,
      wr,
      ({ token, queue, out, inCap }) => {
        requestsSeen += 1
        // Copy before publishing req_rd; QEMU may reuse the ring immediately.
        const req = makeRequest(b, token, queue, out.slice(), inCap, now)
        try {
          b.model.handle(req)
        } catch (err) {
          console.error(`[virtio] ${b.name} model threw; failing the chain`, err)
          req.fail()
        }
      },
    )
    store(b.areaBase + AREA.reqRd, b.reqRd)
    hotUntil = now + HOT_WINDOW_MS
  }

  // Parking is legal; the watchdog catches only unparked chains that were lost.
  if (b.pending.size) {
    for (const [token, p] of b.pending) {
      if (p.parked || now - p.at < WATCHDOG_MS) continue
      console.warn(`[virtio] ${b.name} left a chain unanswered for ${WATCHDOG_MS} ms; failing it`)
      b.pending.delete(token)
      p.req.fail()
    }
  }
}

function poll() {
  timer = 0
  scheduled = false
  if (!exports) return

  const now = performance.now()
  // A MessageChannel wakeup can arrive before the hot-period gate opens.
  if (now < nextHotAt) {
    schedule(nextHotAt - now)
    return
  }

  try {
    if (!bridges.length) rescan()
    for (const b of bridges) pollBridge(b, now)
  } catch (err) {
    // The bridge loop must outlive a bad tick or the guest hangs silently.
    console.error('[virtio] poll failed; the bridge keeps running', err)
  } finally {
    const after = performance.now()
    if (requestWaiterReady) {
      // Requests are event-driven; keep a maintenance tick for resets/watchdogs.
      lastHotPollAt = 0
      nextHotAt = 0
      schedule(IDLE_MS)
    } else if (after < hotUntil) {
      if (lastHotPollAt) {
        const gap = after - lastHotPollAt
        hotGapMsSum += gap
        if (gap > HOT_GAP_SLOW_MS) hotPollsSlow += 1
        hotPolls += 1
      }
      lastHotPollAt = after
      nextHotAt = after + HOT_PERIOD_MS
      schedule(HOT_PERIOD_MS)
    } else {
      lastHotPollAt = 0
      nextHotAt = 0
      schedule(IDLE_MS)
    }
  }
}

function schedule(delay: number) {
  if (scheduled) return
  scheduled = true
  // Hot polls use MessageChannel to dodge timer clamping; idle polls do not.
  if (!requestWaiterReady && hotChannel && delay <= HOT_PERIOD_MS) {
    hotChannel.port2.postMessage(delay)
  } else {
    timer = setTimeout(poll, delay)
  }
}

export function pollOnce() {
  if (!exports) return
  if (!bridges.length) rescan()
  const now = performance.now()
  for (const b of bridges) pollBridge(b, now)
}
