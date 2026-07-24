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
 * Two exports carry every device, present and future:
 * `_qemu_virtio_browser_count()` and `_qemu_virtio_browser_area(i)`. Devices
 * are matched by the `name=` given on the QEMU command line rather than by
 * index or device id — index order is a command-line accident, and two
 * instances can share a device id (two I2C buses).
 *
 * Polling is adaptive, and deliberately not a zero-delay macrotask loop: this
 * is the main thread, and spinning a MessageChannel would starve rendering for
 * as long as traffic lasts. Idle costs one `Atomics.load` per device per 50 ms;
 * for 250 ms after any request it drops to `setTimeout(…, 0)`, which browsers
 * clamp to ~4 ms once nested. With QEMU's own 1 ms completion drain that puts a
 * blocking guest transfer at roughly 5 ms — imperceptible for a GPIO poke, and
 * ~0.6 s for a 127-address `i2c scan`, which is the worst case worth caring
 * about.
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

interface BridgeExports {
  _qemu_virtio_browser_count?: () => number
  _qemu_virtio_browser_area?: (index: number) => number
  HEAPU8?: Uint8Array
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
const HOT_WINDOW_MS = 250
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
let hotUntil = 0

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
  // Deliberately not resolved here: attach runs as soon as the module exists,
  // which can be before QEMU's machine init has realized the devices. The poll
  // loop rescans while it finds none, so an early attach does not latch off.
  schedule(0)
}

export function detach() {
  if (timer) clearTimeout(timer)
  timer = 0
  hotUntil = 0
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
    if (wr === null) return // full; retry next tick
    b.cmpWr = wr
    // Publish only once the record is whole.
    store(b.areaBase + AREA.cmpWr, wr)
    b.outbox.shift()
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
  if (!exports) return

  const now = performance.now()
  try {
    if (!bridges.length) rescan()
    for (const b of bridges) pollBridge(b, now)
  } catch (err) {
    // The loop is the only thing driving every device on the bridge, so it has
    // to outlive a single bad tick. Without this a throw anywhere in here — a
    // malformed area, a model that misbehaves in a way `handle` does not catch
    // — silently stops the timer and the guest hangs with no clue why.
    console.error('[virtio] poll failed; the bridge keeps running', err)
  } finally {
    schedule(now < hotUntil ? 0 : IDLE_MS)
  }
}

function schedule(delay: number) {
  if (timer) return
  timer = setTimeout(poll, delay)
}

/** Test seam: drive one poll iteration synchronously. */
export function pollOnce() {
  if (!exports) return
  if (!bridges.length) rescan()
  const now = performance.now()
  for (const b of bridges) pollBridge(b, now)
}
