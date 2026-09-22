/**
 * The bridge mechanics, with nothing thread-specific in them.
 *
 * `transport.ts` used to hold all of this, which was fine while every device
 * model ran on the main thread. It no longer does: GPIO runs in
 * `deviceWorker.ts`, where the drain loop must behave identically but has no
 * access to the wasm exports. So the parts that only touch the shared heap
 * live here, and the two callers supply the parts that differ:
 *
 * - **Discovery.** `_qemu_virtio_browser_count/_area` are wasm exports, so only
 *   the main thread can enumerate devices. It does, and passes the resulting
 *   area base addresses (plain integers into the shared heap) to whichever host
 *   should own them.
 * - **Waking QEMU.** `_qemu_virtio_browser_kick()` is likewise a wasm export.
 *   The main thread calls it directly; the worker posts a message asking the
 *   main thread to. See `wake` below for why that is not the latency problem it
 *   looks like.
 *
 * Everything else (rings, tokens, parking, the watchdog, wake coalescing) is
 * pure `DataView`/`Atomics` over the shared heap and runs unchanged in either
 * place.
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

/** One descriptor chain, flattened. */
export interface VirtioRequest {
  /** Index of the virtqueue it arrived on. */
  readonly queue: number
  /** The device-readable bytes. A copy, safe to keep. */
  readonly out: Uint8Array
  /** Capacity of the device-writable part. A longer reply is truncated. */
  readonly inCap: number
  /**
   * Answer the chain. May be called later than `handle` returns: a request
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
   * The guest reset the device. Every request handed over is already void, so
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

/**
 * Max virtio requests handled per bridge per poll. gpio-7-segment at a 1 ms
 * refresh can enqueue far more than this; draining them all in one turn was
 * measured to leave the console pty with a blank terminal while I2C/SPI still
 * moved. Leftover requests are reported as backlog so the caller comes back.
 */
const MAX_REQUESTS_PER_POLL = 32

/**
 * A model that never answers hangs the guest on `k_sem_take(..., K_FOREVER)`.
 * Generous, because parking is legal and indefinite: this only catches tokens
 * a device took and then dropped, not ones it is holding on purpose. Models
 * that park must say so by keeping the request object alive.
 */
const WATCHDOG_MS = 5000

interface Pending {
  req: VirtioRequest
  at: number
  /** Parked on purpose: the model asked for the watchdog to be waived. */
  parked: boolean
}

export interface Bridge {
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

export interface BridgeCoreStats {
  /** Requests drained off the request rings. */
  requests: number
  /**
   * Wakes asked for. One poll that answers N queued requests counts as one,
   * so multi-message I2C transfers (register reads) show wakes < requests.
   */
  kicks: number
}

export interface BridgeCoreOptions {
  /** The wasm heap. Shared, so a worker can be handed the same buffer. */
  heap: Uint8Array
  /**
   * Tell QEMU that completions are waiting. On the main thread this calls
   * `_qemu_virtio_browser_kick()`, which schedules a BH to drain under the BQL.
   * From a worker it posts a message asking the main thread to do that.
   *
   * A delayed wake is not a lost completion, and not even a slow one. The
   * record is already published to the ring by the time this is called, and
   * `virtio_browser_arm_drain` in the QEMU patch rearms the realtime drain
   * timer at 1 ms whenever a token is outstanding (50 ms otherwise). Since a
   * blocking guest transfer *is* an outstanding token, QEMU is already looking
   * at the ring every 1 ms while one is in flight. The wake makes that
   * immediate; missing it costs at most that 1 ms, on the QEMU thread, no
   * matter how busy the main thread is.
   */
  wake(): void
}

export interface BridgeCore {
  readonly bridges: readonly Bridge[]
  readonly stats: Readonly<BridgeCoreStats>
  /**
   * Adopt the device at `areaBase` if its header checks out and `model` is
   * willing. Returns the bridge, or null with a reason logged.
   */
  bind(areaBase: number, model: VirtioDeviceModel): Bridge | null
  /** Whether a device carrying this `name=` is bound here. */
  isBound(name: string): boolean
  /**
   * Drain every bound bridge once. Returns true when a bridge hit
   * {@link MAX_REQUESTS_PER_POLL} and still has requests waiting, which the
   * caller must answer by polling again promptly rather than waiting for its
   * next tick: a guest blocked on the remainder publishes nothing further, so
   * no wake is coming to prompt it.
   */
  poll(now: number): boolean
  /**
   * Stop touching the heap. A parked reply can still arrive afterwards (the
   * GPIO model completes an event chain straight out of a panel click), so
   * this makes those safe no-ops rather than faults on a dead buffer.
   */
  release(): void
}

export function createBridgeCore(options: BridgeCoreOptions): BridgeCore {
  const heap = options.heap
  const view = new DataView(heap.buffer)
  const words = new Int32Array(heap.buffer)
  const bridges: Bridge[] = []
  const stats: BridgeCoreStats = { requests: 0, kicks: 0 }
  let released = false

  /* --- index words --------------------------------------------------------
   * Each is written by exactly one side, but both sides read them, so they go
   * through Atomics: the release/acquire pairing with QEMU's
   * qatomic_store_release/load_acquire is what makes "the record is whole
   * before the index moves" true rather than merely likely.
   */

  function load(byteOffset: number): number {
    return Atomics.load(words, byteOffset >> 2) >>> 0
  }

  function store(byteOffset: number, value: number) {
    Atomics.store(words, byteOffset >> 2, value | 0)
  }

  /**
   * Nesting depth of {@link withCoalescedWake}. While > 0, {@link wakeQemu}
   * records a pending wake instead of crossing into QEMU; the outermost exit
   * fires at most one. Depth (not a bool) so a nested call cannot clear the
   * flag early and double-wake.
   */
  let coalesceWakeDepth = 0
  let wakePending = false

  function wakeQemu() {
    if (coalesceWakeDepth > 0) {
      wakePending = true
      return
    }
    doWake()
  }

  /** Bypass coalescing, used when the completion ring is full mid-flush. */
  function forceWakeQemu() {
    wakePending = false
    doWake()
  }

  function doWake() {
    stats.kicks += 1
    try {
      options.wake()
    } catch (err) {
      // A throw here would abort the model's reply and hang the guest on the
      // semaphore; log and let QEMU's drain timer cover it.
      console.error('[virtio] wake failed; drain timer will retry', err)
    }
  }

  /**
   * Run `fn` with completion wakes deferred to a single wake on exit. Nested
   * calls share one window. The guest I2C driver queues a whole multi-message
   * transfer before notifying, so a register read lands here as two or more
   * request records in one drain; answering each with its own wake would
   * schedule that many BHs for work QEMU can finish in one.
   */
  function withCoalescedWake(fn: () => void) {
    coalesceWakeDepth++
    try {
      fn()
    } finally {
      coalesceWakeDepth--
      if (coalesceWakeDepth === 0 && wakePending) {
        wakePending = false
        doWake()
      }
    }
  }

  function enqueue(b: Bridge, token: number, flags: number, payload: Uint8Array | null) {
    b.outbox.push({ token, flags, payload })
    // Answering promptly is the whole point; do not wait for the next tick.
    flush(b)
  }

  /** Write as much of the outbox as the ring will take. */
  function flush(b: Bridge) {
    if (released) return
    let published = 0
    while (b.outbox.length) {
      const next = b.outbox[0]!
      const rd = load(b.areaBase + AREA.cmpRd)
      const wr = writeCompletion(
        heap,
        view,
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
          // inside a coalesced poll, because deferring would stall the outbox
          // until something else wakes, and nothing else will.
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

  function pollBridge(b: Bridge, now: number): boolean {
    // A reset voids every token we hold, so drop the model's in-flight state.
    //
    // What it must *not* do is rewind reqRd. QEMU does not rewind req_wr on
    // reset, so skipping to it discards every request written between the
    // reset and our noticing it, and a discarded request is a guest thread
    // blocked on `k_sem_take(..., K_FOREVER)` forever. Replaying a genuinely
    // stale request instead costs nothing: its token's generation is dead, so
    // QEMU drops the answer. Falling through to the drain below is deliberate
    // for the same reason: a reset and a fresh request can land in one tick.
    const resetGen = load(b.areaBase + AREA.resetGen)
    if (resetGen !== b.resetGen) {
      b.resetGen = resetGen
      b.outbox = []
      b.pending.clear()
      b.model.reset?.()
    }

    flush(b)

    let backlog = false
    const wr = load(b.areaBase + AREA.reqWr)
    if (wr !== b.reqRd) {
      const before = b.reqRd
      b.reqRd = drainRequests(
        heap,
        view,
        b.reqBase,
        b.reqSize,
        b.reqRd,
        wr,
        ({ token, queue, out, inCap }) => {
          stats.requests += 1
          // Copy: `out` is a view into the ring, which QEMU may overwrite the
          // moment we publish req_rd, and a parked request outlives this call
          // by design.
          const req = makeRequest(b, token, queue, out.slice(), inCap, now)
          try {
            b.model.handle(req)
          } catch (err) {
            console.error(`[virtio] ${b.name} model threw; failing the chain`, err)
            req.fail()
          }
        },
        MAX_REQUESTS_PER_POLL,
      )
      store(b.areaBase + AREA.reqRd, b.reqRd)
      if (b.reqRd !== wr && b.reqRd !== before) backlog = true
    }

    // Anything still unanswered after the watchdog is a model that took a
    // chain and lost it. Parking is legal, so this only fires for requests the
    // model no longer references, which we cannot detect, hence the generous
    // bound.
    if (b.pending.size) {
      for (const [token, p] of b.pending) {
        if (p.parked || now - p.at < WATCHDOG_MS) continue
        console.warn(`[virtio] ${b.name} left a chain unanswered for ${WATCHDOG_MS} ms; failing it`)
        b.pending.delete(token)
        p.req.fail()
      }
    }

    return backlog
  }

  return {
    bridges,
    stats,

    bind(areaBase, model) {
      if (released || !areaBase) return null
      if (bridges.some((b) => b.areaBase === areaBase)) return null
      if (view.getUint32(areaBase + AREA.magic, true) !== AREA_MAGIC) {
        console.warn(`[virtio] area at ${areaBase} has a bad magic; ignoring`)
        return null
      }
      const version = view.getUint32(areaBase + AREA.version, true)
      if (version !== AREA_VERSION) {
        console.warn(
          `[virtio] area at ${areaBase} speaks protocol v${version}, this page ` +
            `speaks v${AREA_VERSION}; ignoring. Rebuild the emulator.`,
        )
        return null
      }

      const bridge: Bridge = {
        name: readName(heap, areaBase),
        deviceId: view.getUint32(areaBase + AREA.deviceId, true),
        numQueues: view.getUint32(areaBase + AREA.numQueues, true),
        areaBase,
        reqBase: areaBase + view.getUint32(areaBase + AREA.reqOff, true),
        reqSize: view.getUint32(areaBase + AREA.reqSize, true),
        cmpBase: areaBase + view.getUint32(areaBase + AREA.cmpOff, true),
        cmpSize: view.getUint32(areaBase + AREA.cmpSize, true),
        model,
        // Resume from the shared read index, not from QEMU's write index.
        // req_rd is ours and starts at zero, so this replays everything QEMU
        // has written, which is what we want: anything it wrote and we have
        // not answered is a chain still parked, with a guest thread blocked.
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
      return bridge
    },

    isBound(name) {
      return bridges.some((b) => b.name === name)
    },

    poll(now) {
      let backlog = false
      withCoalescedWake(() => {
        for (const b of bridges) {
          if (pollBridge(b, now)) backlog = true
        }
      })
      return backlog
    },

    release() {
      released = true
      bridges.length = 0
    },
  }
}
