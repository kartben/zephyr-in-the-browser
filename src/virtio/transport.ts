/**
 * Browser end of the generic virtio bridge added by
 * tools/qemu-jit-patches/0010-hw-virtio-add-generic-browser-virtio-bridge.patch.
 *
 * QEMU keeps only what has to happen on its own thread under the BQL — popping
 * descriptor chains, gathering their iovecs, pushing to the used ring, raising
 * the interrupt — and hands each chain here as a flat request. Everything that
 * makes a device *that* device is a `VirtioDeviceModel` in this directory. See
 * docs/virtio-bridge.md for the contract.
 *
 * Two exports discover devices: `_qemu_virtio_browser_count()` and
 * `_qemu_virtio_browser_area(i)`. Devices are matched by the `name=` given on
 * the QEMU command line rather than by index or device id — index order is a
 * command-line accident, and two instances can share a device id (two I2C
 * buses).
 *
 * Completions are kicked back into QEMU rather than waiting on its drain
 * timer: after publishing `cmp_wr` the page `Atomics.notify`s a shared wake
 * word and calls `_qemu_virtio_browser_kick()`, which futex-wakes and
 * `qemu_bh_schedule`s a drain on the QEMU main loop (BQL held — the export
 * itself may run on the browser thread under PROXY_TO_PTHREAD). Without that,
 * every blocking transfer sat until the next realtime drain tick (~50 Hz on
 * dac). Old emulators without the export keep working — they just stay on the
 * timer.
 *
 * Wakes coalesce across one poll tick. The guest I²C driver queues a whole
 * multi-message transfer before notifying, so a register read lands here as
 * two (or more) request records in one drain; answering each with its own
 * kick would schedule that many BHs for work QEMU can finish in one. A single
 * wake after the batch is enough. Delayed replies outside the poll (GPIO
 * event queues) still kick immediately.
 *
 * New emulators wake a dedicated request waiter whenever they publish to a
 * request ring. The waiter blocks in Atomics.wait() on the shared wasm heap,
 * where browser timer clamping does not apply, then posts one task to this
 * thread to run the device models. The models stay here intentionally: several
 * own browser-only state such as localStorage, motion events, and UI
 * subscriptions. Moving request detection is enough to remove the polling
 * floor from every virtio-backed device without duplicating that state.
 *
 * Compatibility remains deliberate. An older emulator has no request-wake
 * export, and a non-pthread fake may have no SharedArrayBuffer, so the previous
 * adaptive timer stays as a fallback: 50 ms while idle, then a MessagePort-
 * reset 1 ms timer while hot. The waiter path still runs that 50 ms maintenance
 * tick for discovery, reset detection, watchdogs, and a completion ring that
 * was temporarily full; it never uses the timer to discover ordinary requests.
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
  /** Byte offset of the futex word the page Atomics.notify-s on completion. */
  _qemu_virtio_browser_wake_addr?: () => number
  /** Byte offset of the futex QEMU notifies after publishing a request. */
  _qemu_virtio_browser_request_wake_addr?: () => number
  /** Drain-cmp BH schedule + main-loop wake (safe from the browser thread). */
  _qemu_virtio_browser_kick?: () => void
  /** Diagnostic: mean ns from virtio_notify() to the RR vCPU thread resuming. */
  _qemu_virtio_wake_avg_ns?: () => number
  _qemu_virtio_wake_max_ns?: () => number
  _qemu_virtio_wake_count?: () => number
  /** Diagnostic: which path actually delivered each completion. */
  _qemu_virtio_notify_via_kick_count?: () => number
  _qemu_virtio_notify_via_timer_count?: () => number
  /**
   * Diagnostic: per-device ns from a request being published to its
   * completion being drained — the whole browser hop, measured on QEMU's own
   * clock so no page/QEMU epoch has to be reconciled. Indexed the same way
   * `_qemu_virtio_browser_area` is.
   */
  _qemu_virtio_browser_roundtrip_avg_ns?: (index: number) => number
  _qemu_virtio_browser_roundtrip_max_ns?: (index: number) => number
  _qemu_virtio_browser_roundtrip_count?: (index: number) => number
  _qemu_virtio_browser_roundtrip_slow_count?: (index: number) => number
  HEAPU8?: Uint8Array
}

/** Diagnostic snapshot of the notify→vCPU-resume gap. See docs/performance.md item 7. */
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

/**
 * Diagnostic: of the completions QEMU has noticed, how many came via the
 * page's kick BH (should be near-instant) versus the periodic drain timer
 * (up to VIRTIO_BROWSER_DRAIN_IDLE_MS/BUSY_MS late). If the kick path is
 * mostly idle, the kick mechanism is not actually engaging and every
 * completion is still timer-paced regardless of how fast that last hop
 * measures.
 */
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

/**
 * One device's round trip, split into the two intervals each side can time
 * with its own clock.
 *
 * `avgNs`/`maxNs` are QEMU's: request published → completion drained, so they
 * cover the futex wake, the waiter worker, the main-thread dispatcher, the
 * device model, and QEMU noticing the answer. `serviceAvgMs` is the page's
 * share of that, from the poll that picked the request up to the reply going
 * into the ring. The difference between them is the two cross-thread hops —
 * the part, and the only part, that moving device models into the wasm
 * module would remove. See docs/performance.md item 15.
 *
 * Both are per device: a model that parks chains by design (virtio-gpio holds
 * one event chain per line, indefinitely) would otherwise bury i2c's answer.
 * Parked chains are excluded from `serviceAvgMs` outright.
 */
export interface RoundTripStats {
  /** QEMU-side mean, ns. -1 when the device has completed nothing yet. */
  avgNs: number
  maxNs: number
  count: number
  /** Of those, how many took more than 5 ms — a hidden tab or a GC, not the loop. */
  slowCount: number
  /** Page-side mean service time, ms. -1 when nothing has been answered. */
  serviceAvgMs: number
  serviceCount: number
}

export function roundTripStats(name: string): RoundTripStats | null {
  const b = bridges.find((x) => x.name === name)
  if (!b) return null
  // The page half is measurable on any build; the QEMU half needs the
  // instrumented emulator and reads as -1/0 without it. Reporting the page
  // half regardless is the point — a profile against an old artifact should
  // say "the hop is unknown", not "there is no service time either".
  return {
    avgNs: exports?._qemu_virtio_browser_roundtrip_avg_ns?.(b.index) ?? -1,
    maxNs: exports?._qemu_virtio_browser_roundtrip_max_ns?.(b.index) ?? -1,
    count: exports?._qemu_virtio_browser_roundtrip_count?.(b.index) ?? 0,
    slowCount: exports?._qemu_virtio_browser_roundtrip_slow_count?.(b.index) ?? 0,
    serviceAvgMs: b.serviceCount ? b.serviceMsSum / b.serviceCount : -1,
    serviceCount: b.serviceCount,
  }
}

/** One descriptor chain, flattened. */
export interface VirtioRequest {
  /** Index of the virtqueue it arrived on. */
  readonly queue: number
  /** The device-readable bytes. A copy — safe to keep. */
  readonly out: Uint8Array
  /** Capacity of the device-writable part. A longer reply is truncated. */
  readonly inCap: number
  /**
   * Answer the chain. May be called later than `handle` returns — a request
   * held indefinitely is exactly virtio-gpio's event queue, where the driver
   * arms a chain per line and the device completes it when the line fires.
   */
  reply(bytes?: Uint8Array | null): void
  /** Complete the chain having written nothing. */
  fail(): void
  /**
   * Declare that this chain is being held on purpose, waiving the watchdog.
   * An interrupt event queue parks a chain per line until the line fires; a
   * model that does that must say so, or the bridge decides after 5 s that it
   * leaked the chain and fails it.
   */
  park(): void
  /** Whether this request has already been answered. */
  readonly answered: boolean
}

export interface VirtioDeviceModel {
  /** Matched against the device's `name=` property. */
  readonly name: string
  handle(req: VirtioRequest): void
  /**
   * The guest reset the device. Every request handed over is already void —
   * drop whatever was parked. Answering afterwards is harmless (the token is
   * stale and QEMU discards it), but pointless.
   */
  reset?(): void
  /**
   * Config space, seeded from the `config=` property so it is correct before
   * the page attaches. Writing to `config` and then calling `notify` raises a
   * configuration-change interrupt in the guest.
   */
  attachConfig?(config: Uint8Array, notify: () => void): void
}

const IDLE_MS = 50
/** How long after a request we keep the paced hot poll alive. */
const HOT_WINDOW_MS = 100
/**
 * Minimum gap between hot-path polls. Without this, `schedule(0)` via
 * MessageChannel busy-loops the main thread for the whole hot window.
 */
const HOT_PERIOD_MS = 1
/**
 * A model that never answers hangs the guest on `k_sem_take(…, K_FOREVER)`.
 * Generous, because parking is legal and indefinite: this only catches tokens
 * a device took and then dropped, not ones it is holding on purpose — models
 * that park must say so by keeping the request object alive.
 */
const WATCHDOG_MS = 5000

interface Pending {
  req: VirtioRequest
  at: number
  /** Parked on purpose: the model asked for the watchdog to be waived. */
  parked: boolean
}

interface Bridge {
  name: string
  /** Registry index, as `_qemu_virtio_browser_area` orders them. */
  index: number
  deviceId: number
  numQueues: number
  areaBase: number
  reqBase: number
  reqSize: number
  cmpBase: number
  cmpSize: number
  model: VirtioDeviceModel
  /** Page-owned indices; QEMU owns req_wr and cmp_rd. */
  reqRd: number
  cmpWr: number
  resetGen: number
  /** Completions computed but not yet written, because the ring was full. */
  outbox: Array<{ token: number; flags: number; payload: Uint8Array | null }>
  pending: Map<number, Pending>
  /**
   * Diagnostic: summed page-side service time, request picked up to reply
   * published, and the number of samples. Parked chains are not counted —
   * holding one is a device's job, not latency. Free-running; a reader diffs
   * or divides, never resets.
   */
  serviceMsSum: number
  serviceCount: number
}

const models = new Map<string, VirtioDeviceModel>()
/**
 * Notified when the set of bound devices changes. Binding happens on the first
 * poll after attach, not during it — QEMU may not have realized the devices
 * yet — so a panel that renders off `available()` needs telling.
 */
const bindListeners = new Set<() => void>()

let exports: BridgeExports | null = null
let heap: Uint8Array | null = null
let view: DataView | null = null
let words: Int32Array | null = null
let bridges: Bridge[] = []
let timer: ReturnType<typeof setTimeout> | 0 = 0
/** A poll is already queued, by either mechanism. */
let scheduled = false
let hotUntil = 0
/** Earliest wall time a hot poll may run; paces the MessagePort loop. */
let nextHotAt = 0
/** Blocks on QEMU's request futex; null means the timer fallback is active. */
let requestWaiter: Worker | null = null
let requestWaiterReady = false

/* --- instrumentation ------------------------------------------------------
 * Free-running counters, never reset — a reader diffs two samples. Kept always
 * on because the cost is two adds per poll against clock reads the loop was
 * making anyway, and because the thing they measure (does the hot loop actually
 * run at the pace it asks for?) is invisible from the outside and was wrong for
 * a long time without anyone noticing. src/display/profile.ts reads them.
 */

export interface BridgeStats {
  /** Hot-window polls that had a predecessor to be timed against. */
  hotPolls: number
  /** Summed gap between consecutive hot polls, ms. Divide for the real pace. */
  hotGapMsSum: number
  /** Of those, how many came more than {@link HOT_GAP_SLOW_MS} apart. */
  hotPollsSlow: number
  /** Requests drained off the request rings. */
  requests: number
  /**
   * Page→QEMU wakes (`Atomics.notify` + kick export). One poll that answers
   * N queued requests counts as one kick, so multi-message I²C transfers
   * (register reads) show kicks < requests. A healthy dac sawtooth is still
   * one message per transfer, so kicks ≈ requests there once the rebuilt
   * emulator is in place.
   */
  kicks: number
  /** Worker futex notifications forwarded to the main-thread dispatcher. */
  waiterWakeups: number
  /** Whether the atomic request waiter is live; false means timer fallback. */
  waiterActive: boolean
}

/**
 * A hot poll slower than this did not get the pace it asked for. Twice the
 * period, so ordinary jitter does not count — but well under the 4 ms a clamped
 * timer would give, so clamping does.
 */
const HOT_GAP_SLOW_MS = 2

let hotPolls = 0
let hotGapMsSum = 0
let hotPollsSlow = 0
let requestsSeen = 0
let kicksSeen = 0
let waiterWakeupsSeen = 0
/** When the previous hot poll ran, or 0 when the last one was an idle tick. */
let lastHotPollAt = 0
/** Int32 index of the emulator's wake futex, or -1 when the export is absent. */
let wakeWordIndex = -1
/**
 * Nesting depth of {@link withCoalescedWake}. While > 0, {@link wakeQemu}
 * records a pending wake instead of crossing into QEMU; the outermost exit
 * fires at most one. Depth (not a bool) so a nested call cannot clear the
 * flag early and double-kick.
 */
let coalesceWakeDepth = 0
/** A wake was requested inside the current coalesce window. */
let wakePending = false

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

/**
 * The hot-path wakeup. A posted message is delivered on the next macrotask and
 * is exempt from the background-tab timer clamp; `setTimeout` is not.
 */
const hotChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null
hotChannel?.port1.addEventListener('message', (ev) => hotWakeup((ev as MessageEvent).data))
hotChannel?.port1.start()

/**
 * Runs as a message task, which is the point: a `setTimeout` armed from here
 * starts at timer nesting level 0, so its 1 ms is honoured rather than clamped
 * to 4 ms the way it would be if the previous poll had armed it directly.
 *
 * A message cannot be cancelled once posted, so this can land after `detach` —
 * `poll` is the one that checks, and calling it clears the scheduling flags
 * rather than leaving a timer armed against a dead module.
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

/**
 * Interrupt the maintenance/fallback timer and drain now. Worker messages are
 * already main-thread tasks, so there is no reason to add another timer hop.
 */
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

/**
 * Start the atomic request detector when this emulator exposes its futex and
 * the heap is actually shared. Every check is capability-based so old release
 * artifacts and unit-test fakes keep using the timer path.
 */
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

/**
 * Register a device model. Call before `attach`; a model whose name no device
 * on the command line carries is simply never bound.
 */
export function register(model: VirtioDeviceModel) {
  models.set(model.name, model)
}

/** Called by the qemu backend once its module is live. */
export function attach(mod: unknown) {
  detach()
  exports = mod as BridgeExports
  // Wake futex is a process-lifetime global in QEMU — safe to resolve now,
  // unlike device areas which appear only after machine init.
  const wakeAddr = exports._qemu_virtio_browser_wake_addr?.()
  wakeWordIndex =
    typeof wakeAddr === 'number' && wakeAddr > 0 && (wakeAddr & 3) === 0 ? wakeAddr >> 2 : -1
  startRequestWaiter()
  // Deliberately not resolving devices here: attach runs as soon as the module
  // exists, which can be before QEMU's machine init has realized them. The poll
  // loop rescans while it finds none, so an early attach does not latch off.
  schedule(0)
}

export function detach() {
  stopRequestWaiter()
  if (timer) clearTimeout(timer)
  timer = 0
  scheduled = false
  hotUntil = 0
  // Not the counters — those are free-running by contract — only the mark the
  // next gap would be measured against, which is meaningless across a detach.
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

/** Whether any device model is bound to a live bridge. */
export function available(): boolean {
  return bridges.length > 0
}

export function boundNames(): string[] {
  return bridges.map((b) => b.name)
}

/** Whether a device carrying this `name=` is bound to a model. */
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
      index: i,
      deviceId: view.getUint32(areaBase + AREA.deviceId, true),
      numQueues: view.getUint32(areaBase + AREA.numQueues, true),
      areaBase,
      reqBase: areaBase + view.getUint32(areaBase + AREA.reqOff, true),
      reqSize: view.getUint32(areaBase + AREA.reqSize, true),
      cmpBase: areaBase + view.getUint32(areaBase + AREA.cmpOff, true),
      cmpSize: view.getUint32(areaBase + AREA.cmpSize, true),
      model,
      // Resume from the shared read index, not from QEMU's write index.
      // req_rd is ours and starts at zero, so this replays everything QEMU has
      // written — which is what we want: anything it wrote and we have not
      // answered is a chain still parked, with a guest thread blocked on it.
      reqRd: load(areaBase + AREA.reqRd),
      cmpWr: load(areaBase + AREA.cmpWr),
      resetGen: load(areaBase + AREA.resetGen),
      outbox: [],
      pending: new Map(),
      serviceMsSum: 0,
      serviceCount: 0,
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
  // Answering promptly is the whole point; do not wait for the next tick.
  flush(b)
  hotUntil = performance.now() + HOT_WINDOW_MS
}

/** Write as much of the outbox as the ring will take. */
function flush(b: Bridge) {
  // A model can answer a parked request at any time, including after the
  // emulator has gone away — the GPIO model completes an event chain straight
  // out of a panel click. Without this the reply would fault on a null heap.
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
      if (published) {
        // Ring full: QEMU must drain before more fits. Force the wake even
        // inside a coalesced poll — deferring would stall the outbox until
        // something else kicks, and nothing else will.
        forceWakeQemu()
      }
      return // full; retry next tick
    }
    b.cmpWr = wr
    // Publish only once the record is whole.
    store(b.areaBase + AREA.cmpWr, wr)
    b.outbox.shift()
    published++
  }
  if (published) wakeQemu()
}

/**
 * Tell QEMU a completion is waiting. Two channels on purpose:
 *
 * 1. `Atomics.notify` on the shared wake word — lock-free from the page, wakes
 *    any futex wait the emulator (or a future drain path) parks on.
 * 2. `_qemu_virtio_browser_kick()` — futex-wakes the same word, schedules a
 *    BH to drain under the BQL on the QEMU thread, and `qemu_notify_event()`s
 *    so `-icount sleep=on` does not sit on the realtime drain timer. Must not
 *    drain inline: the export runs on the browser thread.
 *
 * Either alone is enough on a rebuilt emulator; doing both covers the case
 * where the worker is in a generic sleep futex rather than our wake word.
 * Absent exports (old wasm) this is a no-op and the timer remains the path.
 *
 * Inside {@link withCoalescedWake} this only sets a flag; the outermost exit
 * fires one real wake for the whole batch.
 */
function wakeQemu() {
  if (coalesceWakeDepth > 0) {
    wakePending = true
    return
  }
  doWakeQemu()
}

/** Bypass coalescing — used when the completion ring is full mid-flush. */
function forceWakeQemu() {
  wakePending = false
  doWakeQemu()
}

function doWakeQemu() {
  kicksSeen += 1
  if (words && wakeWordIndex >= 0) {
    Atomics.add(words, wakeWordIndex, 1)
    Atomics.notify(words, wakeWordIndex)
  }
  try {
    exports?._qemu_virtio_browser_kick?.()
  } catch (err) {
    // A throw here would abort the model's reply and hang the guest on the
    // semaphore; log and let the drain timer cover it.
    console.error('[virtio] kick failed; drain timer will retry', err)
  }
}

/**
 * Run `fn` with completion wakes deferred to a single kick on exit. Nested
 * calls share one window. Used by both the timer/waiter poll and the test
 * `pollOnce` seam so multi-message I²C batches pay one BH, not N.
 */
function withCoalescedWake(fn: () => void) {
  coalesceWakeDepth++
  try {
    fn()
  } finally {
    coalesceWakeDepth--
    if (coalesceWakeDepth === 0 && wakePending) {
      wakePending = false
      doWakeQemu()
    }
  }
}

/** Builds the request and registers it as pending in one step. */
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
  /**
   * How long the page held this chain: the poll that picked it up through the
   * model to the completion record being written. `entry.at` is the poll's
   * clock rather than a fresh reading, deliberately — the dispatch that got
   * here is part of what the guest waited for, so it belongs inside the
   * measurement. Called after `enqueue` for the same reason: `flush` writing
   * the record is the page's work too. The kick that follows is not, since a
   * poll now coalesces one for the whole batch.
   */
  const noteService = () => {
    if (entry.parked) return
    b.serviceMsSum += performance.now() - entry.at
    b.serviceCount += 1
  }
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
      noteService()
    },
    fail() {
      if (answered) return
      answered = true
      b.pending.delete(token)
      enqueue(b, token, CMP_FAIL, null)
      noteService()
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
  // A reset voids every token we hold, so drop the model's in-flight state.
  //
  // What it must *not* do is rewind reqRd. QEMU does not rewind req_wr on
  // reset, so skipping to it discards every request written between the reset
  // and our noticing it — and a discarded request is a guest thread blocked on
  // `k_sem_take(…, K_FOREVER)` forever. Replaying a genuinely stale request
  // instead costs nothing: its token's generation is dead, so QEMU drops the
  // answer. Falling through to the drain below is deliberate for the same
  // reason — a reset and a fresh request can land in the same tick.
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
        // Copy: `out` is a view into the ring, which QEMU may overwrite the
        // moment we publish req_rd — and a parked request outlives this call
        // by design.
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

  // Anything still unanswered after the watchdog is a model that took a chain
  // and lost it. Parking is legal, so this only fires for requests the model
  // no longer references — which we cannot detect, hence the generous bound.
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
  // A MessageChannel wakeup can land before the hot-period gate opens; yield
  // until then rather than spinning empty polls.
  if (now < nextHotAt) {
    schedule(nextHotAt - now)
    return
  }

  try {
    withCoalescedWake(() => {
      if (!bridges.length) rescan()
      for (const b of bridges) pollBridge(b, now)
    })
  } catch (err) {
    // The loop is the only thing driving every device on the bridge, so it has
    // to outlive a single bad tick. Without this a throw anywhere in here — a
    // malformed area, a model that misbehaves in a way `handle` does not catch
    // — silently stops the timer and the guest hangs with no clue why.
    console.error('[virtio] poll failed; the bridge keeps running', err)
  } finally {
    const after = performance.now()
    if (requestWaiterReady) {
      // Request arrival is event-driven. Keep only the maintenance tick for
      // discovery, resets, watchdogs, and a temporarily full completion ring.
      lastHotPollAt = 0
      nextHotAt = 0
      schedule(IDLE_MS)
    } else if (after < hotUntil) {
      // Paced, not unpaced: an unpaced port loop was measured at ~700k
      // Atomics.loads/s while accel_chart kept the bridge hot, starving
      // qemu-wasm on the same thread. 1 ms still answers well inside a guest
      // sample period. `schedule` routes this through the port so the pace is
      // the one asked for rather than the 4 ms a nested timer would be given.
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
  // Anything at hot-loop pace goes through the port, which both dodges the
  // background-tab clamp and resets the timer nesting level (see hotWakeup).
  // The idle timer is left alone: it is one load per device per 50 ms, and a
  // message hop per tick would cost more than it saves.
  if (!requestWaiterReady && hotChannel && delay <= HOT_PERIOD_MS) {
    hotChannel.port2.postMessage(delay)
  } else {
    timer = setTimeout(poll, delay)
  }
}

/** Test seam: drive one poll iteration synchronously. */
export function pollOnce() {
  if (!exports) return
  withCoalescedWake(() => {
    if (!bridges.length) rescan()
    const now = performance.now()
    for (const b of bridges) pollBridge(b, now)
  })
}
