/**
 * A JS stand-in for `hw/virtio/virtio-browser.c`, backed by a plain
 * Uint8Array "heap". Tests attach this to the transport so the entire
 * production path — discovery, ring codec, dispatch, parking, reset — runs
 * with no QEMU assets, the arrangement src/net/testing/fakeModule.ts already
 * uses for the netdev rings.
 *
 * The `guest` handle is the far end: `kick` submits a descriptor chain the way
 * a driver would, `completions` collects what the device pushed back.
 */

import {
  AREA,
  AREA_BYTES,
  AREA_MAGIC,
  AREA_VERSION,
  CMP_HDR,
  REQ_HDR,
  TOKEN_SKIP,
  align4,
} from '../protocol'

export interface FakeCompletion {
  token: number
  flags: number
  data: Uint8Array
}

export interface FakeDevice {
  /** Submit a chain the way a guest driver would. Returns its token. */
  kick(queue: number, out: Uint8Array, inCap: number): number
  /** Everything the device has completed since the last call. */
  completions(): FakeCompletion[]
  /** What the guest would see in config space. */
  config: Uint8Array
  /** Bumped by the page when it wants a config-change interrupt. */
  configGen(): number
  /** Reset the device, as a guest driver rebinding would. */
  reset(): void
  /** Requests QEMU handed over and has not been answered for. */
  outstanding(): number
}

export interface FakeBridge {
  /** Shaped like the Emscripten instance the transport expects. */
  module: Record<string, unknown>
  device(name: string): FakeDevice
}

export interface FakeDeviceSpec {
  name: string
  deviceId: number
  numQueues?: number
  /** Initial config space, as QEMU's `config=` property would seed it. */
  config?: Uint8Array
  /** Deliberately small by default, so tests hit the wrap and skip paths. */
  ringSize?: number
}

export interface FakeBridgeOptions {
  /**
   * Back the heap with a SharedArrayBuffer, as `-pthread` does for real. Worth
   * doing at least once per suite: several APIs quietly refuse shared views —
   * `TextDecoder.decode` throws outright — so a plain ArrayBuffer can pass a
   * test that fails against QEMU.
   */
  shared?: boolean
}

export function createFakeBridge(
  specs: FakeDeviceSpec[],
  options: FakeBridgeOptions = {},
): FakeBridge {
  // Lay every device out back to back: area, request ring, completion ring.
  const layouts = specs.map((spec) => ({
    spec,
    ringSize: spec.ringSize ?? 4096,
  }))
  // Offset 0 is left unused: a real device pointer is never null, and the
  // transport reads a zero from _area(i) as "no such device". The next two
  // words mirror QEMU's completion and request futex exports.
  const COMPLETION_WAKE_ADDR = 8
  const REQUEST_WAKE_ADDR = 12
  const HEAP_BASE = 16
  const total = layouts.reduce((n, l) => n + AREA_BYTES + 2 * l.ringSize, HEAP_BASE)
  const bytes = align4(total)
  const heap = new Uint8Array(
    options.shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes),
  )
  const view = new DataView(heap.buffer)
  const words = new Int32Array(heap.buffer)

  const load = (byteOffset: number) => Atomics.load(words, byteOffset >> 2) >>> 0
  const store = (byteOffset: number, value: number) =>
    Atomics.store(words, byteOffset >> 2, value | 0)

  const devices = new Map<string, FakeDevice>()
  const areaBases: number[] = []
  /**
   * The round-trip counters `0018-instrument-bridge-roundtrip.patch` keeps in
   * C, per device and in the same registry order, so the transport's
   * index-to-device mapping is exercised here rather than only against a
   * rebuilt emulator. `completions()` stands in for QEMU's drain.
   */
  const roundTrips: Array<{ sumNs: number; maxNs: number; count: number; slow: number }> = []

  let cursor = HEAP_BASE
  for (const { spec, ringSize } of layouts) {
    if (spec.name.length >= 16) {
      throw new Error(`fake bridge: name "${spec.name}" does not fit in 16 bytes`)
    }
    const areaBase = cursor
    const reqBase = areaBase + AREA_BYTES
    const cmpBase = reqBase + ringSize
    cursor = cmpBase + ringSize
    areaBases.push(areaBase)

    view.setUint32(areaBase + AREA.magic, AREA_MAGIC, true)
    view.setUint32(areaBase + AREA.version, AREA_VERSION, true)
    view.setUint32(areaBase + AREA.deviceId, spec.deviceId, true)
    view.setUint32(areaBase + AREA.numQueues, spec.numQueues ?? 1, true)
    heap.set(new TextEncoder().encode(spec.name), areaBase + AREA.name)
    view.setUint32(areaBase + AREA.reqOff, AREA_BYTES, true)
    view.setUint32(areaBase + AREA.reqSize, ringSize, true)
    view.setUint32(areaBase + AREA.cmpOff, AREA_BYTES + ringSize, true)
    view.setUint32(areaBase + AREA.cmpSize, ringSize, true)
    if (spec.config) {
      heap.set(spec.config, areaBase + AREA.config)
      view.setUint32(areaBase + AREA.configLen, spec.config.length, true)
    }

    // Token bookkeeping, mirroring the C parked-element table.
    let nextSlot = 0
    const generations = new Uint16Array(64)
    const live = new Set<number>()
    let cmpRd = 0
    const rt = { sumNs: 0, maxNs: 0, count: 0, slow: 0 }
    roundTrips.push(rt)
    /** Token → publish time, the C token's `published_ns`. */
    const publishedAt = new Map<number, number>()

    const setOutstanding = () => store(areaBase + AREA.outstanding, live.size)

    devices.set(spec.name, {
      config: heap.subarray(areaBase + AREA.config, areaBase + AREA.config + 64),

      configGen: () => load(areaBase + AREA.configGen),

      outstanding: () => live.size,

      kick(queue, out, inCap) {
        const slot = nextSlot
        nextSlot = (nextSlot + 1) % 64
        const token = (slot | (generations[slot] << 16)) >>> 0

        const rec = REQ_HDR + align4(out.length)
        let wr = load(areaBase + AREA.reqWr)
        const rd = load(areaBase + AREA.reqRd)
        let off = wr % ringSize
        const pad = ringSize - off < rec ? ringSize - off : 0
        if (ringSize - ((wr - rd) >>> 0) < pad + rec) {
          throw new Error('fake bridge: request ring full')
        }
        if (pad) {
          view.setUint32(reqBase + off, TOKEN_SKIP, true)
          wr = (wr + pad) >>> 0
          off = 0
        }
        view.setUint32(reqBase + off, token, true)
        view.setUint16(reqBase + off + 4, queue, true)
        view.setUint16(reqBase + off + 6, 0, true)
        view.setUint32(reqBase + off + 8, out.length, true)
        view.setUint32(reqBase + off + 12, inCap, true)
        heap.set(out, reqBase + off + REQ_HDR)
        store(areaBase + AREA.reqWr, (wr + rec) >>> 0)
        publishedAt.set(token, performance.now())
        Atomics.add(words, REQUEST_WAKE_ADDR >> 2, 1)
        Atomics.notify(words, REQUEST_WAKE_ADDR >> 2)

        live.add(token)
        setOutstanding()
        return token
      },

      completions() {
        const out: FakeCompletion[] = []
        const wr = load(areaBase + AREA.cmpWr)
        while (cmpRd !== wr) {
          const off = cmpRd % ringSize
          const token = view.getUint32(cmpBase + off, true)
          if (token === TOKEN_SKIP) {
            cmpRd = (cmpRd + (ringSize - off)) >>> 0
            continue
          }
          const flags = view.getUint16(cmpBase + off + 4, true)
          const inLen = view.getUint32(cmpBase + off + 8, true)
          const start = cmpBase + off + CMP_HDR
          out.push({ token, flags, data: heap.slice(start, start + inLen) })
          cmpRd = (cmpRd + CMP_HDR + align4(inLen)) >>> 0

          if (live.delete(token)) {
            generations[token & 0xffff]++
            setOutstanding()
          }
          const published = publishedAt.get(token)
          if (published !== undefined) {
            publishedAt.delete(token)
            const ns = (performance.now() - published) * 1e6
            rt.sumNs += ns
            rt.count++
            if (ns > rt.maxNs) rt.maxNs = ns
            if (ns > 5e6) rt.slow++
          }
        }
        store(areaBase + AREA.cmpRd, cmpRd)
        return out
      },

      reset() {
        for (const token of live) generations[token & 0xffff]++
        live.clear()
        publishedAt.clear()
        setOutstanding()
        // Neither side rewinds an index the other owns: QEMU skips whatever
        // the page had queued and bumps the generation.
        cmpRd = load(areaBase + AREA.cmpWr)
        store(areaBase + AREA.cmpRd, cmpRd)
        store(areaBase + AREA.resetGen, load(areaBase + AREA.resetGen) + 1)
      },
    })
  }

  return {
    module: {
      HEAPU8: heap,
      _qemu_virtio_browser_count: () => specs.length,
      _qemu_virtio_browser_area: (i: number) => areaBases[i] ?? 0,
      _qemu_virtio_browser_wake_addr: () => COMPLETION_WAKE_ADDR,
      _qemu_virtio_browser_request_wake_addr: () => REQUEST_WAKE_ADDR,
      // Completions are already visible on the fake heap; kick is a no-op so
      // tests exercise the page path without needing a drain timer.
      _qemu_virtio_browser_kick: () => {
        Atomics.add(words, COMPLETION_WAKE_ADDR >> 2, 1)
        Atomics.notify(words, COMPLETION_WAKE_ADDR >> 2)
      },
      _qemu_virtio_browser_roundtrip_avg_ns: (i: number) => {
        const rt = roundTrips[i]
        return rt?.count ? rt.sumNs / rt.count : -1
      },
      _qemu_virtio_browser_roundtrip_max_ns: (i: number) => roundTrips[i]?.maxNs ?? -1,
      _qemu_virtio_browser_roundtrip_count: (i: number) => roundTrips[i]?.count ?? 0,
      _qemu_virtio_browser_roundtrip_slow_count: (i: number) => roundTrips[i]?.slow ?? 0,
    },
    device(name) {
      const d = devices.get(name)
      if (!d) throw new Error(`fake bridge: no device named "${name}"`)
      return d
    },
  }
}
