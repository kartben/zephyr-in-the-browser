/**
 * Browser end of the generic virtio bridge added by
 * tools/qemu-jit-patches/0010-hw-virtio-add-generic-browser-virtio-bridge.patch.
 *
 * QEMU keeps only what has to happen on its own thread under the BQL (popping
 * descriptor chains, gathering their iovecs, pushing to the used ring, raising
 * the interrupt) and hands each chain over as a flat request. Everything that
 * makes a device *that* device is a `VirtioDeviceModel` in this directory. See
 * docs/virtio-bridge.md for the contract.
 *
 * Two exports discover devices: `_qemu_virtio_browser_count()` and
 * `_qemu_virtio_browser_area(i)`. Devices are matched by the `name=` given on
 * the QEMU command line rather than by index or device id, because index order
 * is a command-line accident and two instances can share a device id (two I2C
 * buses).
 *
 * This module is now only the main-thread half. The ring mechanics live in
 * `bridgeCore.ts` so they can run in either context, and device execution is
 * splitting away from presentation one bus at a time:
 *
 * - **`deviceWorker.ts` owns the request futex** and drains the bridges routed
 *   to it ({@link setWorkerOwnedModels}, GPIO today). It also decides when the
 *   main thread has work, by comparing the published `req_wr`/`req_rd` of the
 *   areas this thread owns, so a GPIO request never wakes this thread at all.
 *   That is the point: gpio-7-segment multiplexes at 1 ms, and the cap in
 *   `bridgeCore.ts` exists because draining that on this thread was measured to
 *   leave the console pty blank.
 * - **This thread keeps what is bound to a wasm export.** Discovery and
 *   `_qemu_virtio_browser_kick()` can only be called where the Module lives, so
 *   the worker asks for a kick and this thread performs it.
 *
 * A kick that waits on a busy main thread is not a stalled completion. The
 * record is in the ring before the kick is asked for, and QEMU's
 * `virtio_browser_arm_drain` rearms its realtime drain timer at 1 ms whenever a
 * token is outstanding, which is exactly when a guest is blocked waiting. The
 * kick makes the answer immediate; missing it costs at most that 1 ms, and
 * costs it on the QEMU thread rather than behind a React commit.
 *
 * There is no timer fallback for requests: a bridge that quietly drops back to
 * timer pace is the kind of regression that hides for months behind "it feels
 * slow". A 50 ms maintenance tick still runs, but only for discovery, reset
 * detection, the unanswered-chain watchdog, and a completion ring that was
 * temporarily full.
 */

import type { BridgeCore, VirtioDeviceModel } from './bridgeCore'
import { createBridgeCore } from './bridgeCore'
import { readName } from './protocol'
import type { DeviceWorkerToMain, MainToDeviceWorker } from './deviceWorker'

export type { VirtioDeviceModel, VirtioRequest } from './bridgeCore'

/**
 * The five core exports are required, not optional: every machine that carries
 * a virtio-browser device has them. The diagnostics below really are optional:
 * riscv32 and xtensa are patched from tools/qemu-esp-patches/, which carries no
 * diagnostics patches at all.
 */
interface BridgeExports {
  _qemu_virtio_browser_count: () => number
  _qemu_virtio_browser_area: (index: number) => number
  /** Byte offset of the futex word the page Atomics.notify-s on completion. */
  _qemu_virtio_browser_wake_addr: () => number
  /** Byte offset of the futex QEMU notifies after publishing a request. */
  _qemu_virtio_browser_request_wake_addr: () => number
  /** Drain-cmp BH schedule + main-loop wake (safe from the browser thread). */
  _qemu_virtio_browser_kick: () => void
  /** Diagnostic: mean ns from virtio_notify() to the RR vCPU thread resuming. */
  _qemu_virtio_wake_avg_ns?: () => number
  _qemu_virtio_wake_max_ns?: () => number
  _qemu_virtio_wake_count?: () => number
  /** Diagnostic: which path actually delivered each completion. */
  _qemu_virtio_notify_via_kick_count?: () => number
  _qemu_virtio_notify_via_timer_count?: () => number
  HEAPU8?: Uint8Array
}

/** Diagnostic snapshot of the notify to vCPU-resume gap. See docs/performance.md item 7. */
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
 * Maintenance tick. Not a detection path: the worker notices every request.
 * This covers discovery, reset detection, the watchdog, and retrying a
 * completion ring that was momentarily full.
 */
const IDLE_MS = 50

/**
 * Models that run in {@link deviceWorker}. GPIO is here because it is the
 * highest-rate device on the bridge and the only one with no browser-owned
 * state: no localStorage, no motion events, no devicetree. The I2C and SPI
 * chips own all three, so they stay on this thread until each has a
 * replicated-store answer.
 */
const DEFAULT_WORKER_OWNED: readonly string[] = ['gpio']

let workerOwned: ReadonlySet<string> = new Set(DEFAULT_WORKER_OWNED)

/**
 * Test seam. Node has no `Worker`, and most of the suite drives the bridge
 * synchronously through {@link pollOnce}; passing an empty list keeps every
 * model in-process so those tests read as they always did.
 */
export function setWorkerOwnedModels(names: readonly string[]) {
  workerOwned = new Set(names)
}

export function resetWorkerOwnedModelsForTest() {
  workerOwned = new Set(DEFAULT_WORKER_OWNED)
}

const models = new Map<string, VirtioDeviceModel>()
/**
 * Notified when the set of bound devices changes. Binding happens on the first
 * poll after attach, not during it (QEMU may not have realized the devices
 * yet), so a panel that renders off `available()` needs telling.
 */
const bindListeners = new Set<() => void>()

/** Device-specific traffic between a worker-owned model and this thread. */
export interface DeviceMessage {
  name: string
  payload: unknown
}

const deviceMessageListeners = new Set<(message: DeviceMessage) => void>()

let exports: BridgeExports | null = null
let heap: Uint8Array | null = null
/** Bridges this thread drains. Worker-owned ones are not in here. */
let core: BridgeCore | null = null
let timer: ReturnType<typeof setTimeout> | 0 = 0
/** A poll is already queued, by the timer or by a worker wake. */
let scheduled = false
/**
 * A bridge hit the per-poll request cap and still has work. The worker only
 * wakes us when QEMU publishes, and a guest blocked on the remainder publishes
 * nothing, so the leftovers have to be chased rather than waited for.
 */
let backlog = false
let deviceWorker: Worker | null = null
/** Areas handed to the worker, by the `name=` they carry. */
const workerAreas = new Map<number, string>()

let waiterWakeupsSeen = 0
/** Cumulative counters last reported by the worker, so `stats()` covers both. */
let workerRequests = 0
let workerKicks = 0

export interface BridgeStats {
  /** Requests drained off the request rings, on either thread. */
  requests: number
  /**
   * Page to QEMU wakes. One poll that answers N queued requests counts as one
   * kick, so multi-message I2C transfers (register reads) show kicks less than
   * requests.
   */
  kicks: number
  /** Futex notifications the worker forwarded to this thread. */
  waiterWakeups: number
}

export function stats(): BridgeStats {
  return {
    requests: (core?.stats.requests ?? 0) + workerRequests,
    kicks: (core?.stats.kicks ?? 0) + workerKicks,
    waiterWakeups: waiterWakeupsSeen,
  }
}

/**
 * Tell QEMU a completion is waiting: schedule a BH to drain the cmp rings on
 * the QEMU main loop (BQL held, since the keepalive export may run on the
 * browser thread) and `qemu_notify_event()` a halted vCPU so `-icount sleep=on`
 * does not sit on the realtime drain timer.
 *
 * Note that the `Atomics.notify` this used to also do was decorative: nothing
 * in QEMU ever waits on `virtio_browser_wake`. The BH is the mechanism.
 */
function kickQemu() {
  exports?._qemu_virtio_browser_kick()
}

/* --- the device worker ---------------------------------------------------- */

function stopDeviceWorker() {
  deviceWorker?.terminate()
  deviceWorker = null
  workerAreas.clear()
  workerRequests = 0
  workerKicks = 0
}

/**
 * Losing the worker is not a degradation to be logged and lived with: nothing
 * else notices a request, so every virtio device on the board drops to the
 * 50 ms maintenance tick at best, and any guest already blocked in
 * `k_sem_take(..., K_FOREVER)` stays there. Say so at error level, because the
 * symptom alone (a board that looks alive and answers nothing) points nowhere.
 */
function onDeviceWorkerFailure(message: string) {
  if (!deviceWorker) return
  stopDeviceWorker()
  console.error(
    `[virtio] the device worker stopped (${message}). Nothing is watching the ` +
      'request rings any more, so virtio devices will stall or hang. Reload the page.',
  )
}

/** Interrupt the maintenance timer and drain now. */
function pollFromWake() {
  if (!exports) return
  if (timer) clearTimeout(timer)
  timer = 0
  scheduled = false
  poll()
}

function onWorkerMessage(message: DeviceWorkerToMain) {
  switch (message.type) {
    case 'wake':
      waiterWakeupsSeen += message.count
      pollFromWake()
      break
    case 'kick':
      // The worker published completions for its own bridges and cannot reach
      // the export. See the header: this being late is bounded by QEMU's 1 ms
      // busy drain, not by how long this thread stays busy.
      workerRequests = message.requests
      workerKicks = message.kicks
      kickQemu()
      break
    case 'bound':
      notifyBinds()
      break
    case 'device':
      for (const fn of deviceMessageListeners) fn({ name: message.name, payload: message.payload })
      break
    case 'fatal':
      onDeviceWorkerFailure(message.message)
      break
  }
}

/**
 * Start the device worker, after a sanity check on the request-wake address,
 * because a bad one parks the worker on the wrong word and looks from the
 * outside exactly like a hung guest.
 */
function startDeviceWorker() {
  const mod = exports
  const h = mod?.HEAPU8
  if (!mod || !h) return
  if (typeof Worker !== 'function') return
  const requestWakeAddr = mod._qemu_virtio_browser_request_wake_addr()
  if (
    requestWakeAddr <= 0 ||
    (requestWakeAddr & 3) !== 0 ||
    requestWakeAddr >= h.buffer.byteLength
  ) {
    console.error(
      `[virtio] request-wake address ${requestWakeAddr} is not a word-aligned ` +
        'offset into the wasm heap; virtio devices will not be served',
    )
    return
  }

  try {
    const wordIndex = requestWakeAddr >> 2
    // Read before the worker exists, so a request published between this and
    // its first wait comes back as an immediate wake rather than a lost edge.
    const expected = Atomics.load(new Int32Array(h.buffer), wordIndex)
    const worker = new Worker(new URL('./deviceWorker.ts', import.meta.url), {
      type: 'module',
    })
    deviceWorker = worker
    worker.onmessage = (event: MessageEvent<DeviceWorkerToMain>) => onWorkerMessage(event.data)
    worker.onerror = (event) => onDeviceWorkerFailure(event.message || 'worker error')
    postToWorker({
      type: 'start',
      // -pthread makes every emulator heap shared, and the worker waits on it,
      // which a non-shared buffer rejects outright.
      buffer: h.buffer as SharedArrayBuffer,
      wordIndex,
      expected,
    })
  } catch (error) {
    stopDeviceWorker()
    console.error(
      '[virtio] could not start the device worker; virtio devices will not be served',
      error,
    )
  }
}

function postToWorker(message: MainToDeviceWorker) {
  deviceWorker?.postMessage(message)
}

/**
 * Send a payload to a worker-owned model (a GPIO input word, say). A no-op
 * when that model is running in-process, where the caller talks to it directly.
 */
export function postToDevice(name: string, payload: unknown) {
  if (!deviceWorker) return
  postToWorker({ type: 'device', name, payload })
}

/**
 * Whether `name` is being executed in the worker right now. False when no
 * worker started, which is how a caller knows to talk to its in-process model
 * directly instead of posting to one that is not there.
 */
export function isWorkerOwned(name: string): boolean {
  return deviceWorker !== null && workerOwned.has(name)
}

export function subscribeDeviceMessages(fn: (message: DeviceMessage) => void): () => void {
  deviceMessageListeners.add(fn)
  return () => deviceMessageListeners.delete(fn)
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
  heap = exports.HEAPU8 ?? null
  if (heap) core = createBridgeCore({ heap, wake: kickQemu })
  startDeviceWorker()
  // Deliberately not resolving devices here: attach runs as soon as the module
  // exists, which can be before QEMU's machine init has realized them. The poll
  // loop rescans while it finds none, so an early attach does not latch off.
  schedule(0)
}

export function detach() {
  stopDeviceWorker()
  if (timer) clearTimeout(timer)
  timer = 0
  scheduled = false
  backlog = false
  waiterWakeupsSeen = 0
  const had = available()
  core?.release()
  core = null
  exports = null
  heap = null
  if (had) notifyBinds()
}

/** Whether any device model is bound to a live bridge. */
export function available(): boolean {
  return (core?.bridges.length ?? 0) > 0 || workerAreas.size > 0
}

export function boundNames(): string[] {
  return [...(core?.bridges.map((b) => b.name) ?? []), ...workerAreas.values()]
}

/** Whether a device carrying this `name=` is bound to a model. */
export function isBound(name: string): boolean {
  return (core?.isBound(name) ?? false) || [...workerAreas.values()].includes(name)
}

export function subscribeBinds(fn: () => void): () => void {
  bindListeners.add(fn)
  return () => bindListeners.delete(fn)
}

function notifyBinds() {
  for (const fn of bindListeners) fn()
}

/* --- discovery ------------------------------------------------------------
 * Only this thread can enumerate: the count and area exports are wasm. What it
 * hands the worker is a plain integer offset into the heap they share.
 */

function rescan() {
  const before = boundNames().length
  rescanInner()
  if (boundNames().length !== before) notifyBinds()
}

function rescanInner() {
  if (!exports || !heap || !core) return
  const count = exports._qemu_virtio_browser_count()
  if (!count) return

  let routed = false
  for (let i = 0; i < count; i++) {
    const areaBase = exports._qemu_virtio_browser_area(i)
    if (!areaBase || workerAreas.has(areaBase)) continue
    if (core.bridges.some((b) => b.areaBase === areaBase)) continue

    const name = readName(heap, areaBase)
    if (workerOwned.has(name) && deviceWorker) {
      // The worker validates the header itself and answers with 'bound'. It
      // has the same heap, so nothing but the offset needs to cross.
      workerAreas.set(areaBase, name)
      postToWorker({ type: 'bind', areaBase, name })
      routed = true
      continue
    }

    const model = models.get(name)
    if (!model) {
      console.warn(`[virtio] no model registered for device "${name}"`)
      continue
    }
    if (core.bind(areaBase, model)) routed = true
  }

  // Let the worker filter its wakes: it only interrupts this thread when one of
  // these areas has an unread request, so GPIO traffic never reaches us.
  if (routed && deviceWorker) {
    postToWorker({ type: 'mainAreas', areas: core.bridges.map((b) => b.areaBase) })
  }
}

/* --- the loop ------------------------------------------------------------- */

function poll() {
  timer = 0
  scheduled = false
  if (!exports || !core) return

  try {
    if (!core.bridges.length || workerAreas.size === 0) rescan()
    backlog = core.poll(performance.now())
  } catch (err) {
    // The loop is the only thing driving every device this thread owns, so it
    // has to outlive a single bad tick. Without this a throw anywhere in here
    // (a malformed area, a model that misbehaves in a way `handle` does not
    // catch) silently stops the timer and the guest hangs with no clue why.
    console.error('[virtio] poll failed; the bridge keeps running', err)
  } finally {
    // Request arrival is event-driven, so this is only the maintenance tick,
    // unless a drain hit the per-poll cap: then come right back.
    schedule(backlog ? 0 : IDLE_MS)
  }
}

function schedule(delay: number) {
  if (scheduled) return
  scheduled = true
  timer = setTimeout(poll, delay)
}

/** Test seam: drive one poll iteration synchronously. */
export function pollOnce() {
  if (!exports || !core) return
  rescan()
  core.poll(performance.now())
}
