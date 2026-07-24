/**
 * The wire format shared with `hw/virtio/virtio-browser.c` in the patched QEMU
 * (tools/qemu-jit-patches/0010-*). See docs/virtio-bridge.md for the contract
 * this implements; if you change one, change all three.
 *
 * Used against the real wasm heap by transport.ts and against a plain
 * Uint8Array by the test fake, so both sides exercise the same codec — the
 * arrangement src/net/ringCodec.ts already uses for the netdev rings.
 */

/** "VBRG", little-endian. */
export const AREA_MAGIC = 0x47524256
export const AREA_VERSION = 1

/**
 * Byte offsets into `VirtioBrowserArea`. Every field is naturally aligned and
 * the C struct has no padding, so these are just the running sum — but they
 * are spelled out rather than computed, because a mismatch here is a silent
 * misread of shared memory rather than a compile error.
 */
export const AREA = {
  magic: 0,
  version: 4,
  deviceId: 8,
  numQueues: 12,
  name: 16,
  reqOff: 32,
  reqSize: 36,
  cmpOff: 40,
  cmpSize: 44,
  reqWr: 48,
  reqRd: 52,
  cmpWr: 56,
  cmpRd: 60,
  outstanding: 64,
  resetGen: 68,
  configLen: 72,
  configGen: 76,
  config: 80,
} as const

export const NAME_MAX = 16
export const CONFIG_MAX = 64
/** sizeof(VirtioBrowserArea). */
export const AREA_BYTES = 144

export const REQ_HDR = 16
export const CMP_HDR = 12

/** A token of all-ones is not a record but "skip to the next lap". */
export const TOKEN_SKIP = 0xffffffff

export const CMP_OK = 0x0
/** Complete the chain having written nothing. */
export const CMP_FAIL = 0x1

/** Matches VIRTIO_BROWSER_MAX_PAYLOAD; larger records mean a corrupt ring. */
export const MAX_PAYLOAD = 4096

export const align4 = (n: number) => (n + 3) & ~3

export interface RawRequest {
  token: number
  queue: number
  /** A view into the ring — the caller must copy before yielding. */
  out: Uint8Array
  inCap: number
}

/**
 * Read every complete request between `rd` and `wr`, returning the advanced
 * read index. `onRequest` receives a view into the ring, valid only for the
 * duration of the call.
 */
export function drainRequests(
  heap: Uint8Array,
  view: DataView,
  base: number,
  size: number,
  rd: number,
  wr: number,
  onRequest: (req: RawRequest) => void,
): number {
  while (rd !== wr) {
    const off = rd % size
    const token = view.getUint32(base + off, true)
    if (token === TOKEN_SKIP) {
      rd = (rd + (size - off)) >>> 0
      continue
    }

    const queue = view.getUint16(base + off + 4, true)
    const outLen = view.getUint32(base + off + 8, true)
    const inCap = view.getUint32(base + off + 12, true)
    const rec = REQ_HDR + align4(outLen)

    // QEMU publishes req_wr only once a record is whole, so a record running
    // past it means the ring is corrupt. Resync rather than read on into
    // whatever happens to follow.
    if (outLen > MAX_PAYLOAD || rec > ((wr - rd) >>> 0)) return wr

    const start = base + off + REQ_HDR
    onRequest({ token, queue, out: heap.subarray(start, start + outLen), inCap })
    rd = (rd + rec) >>> 0
  }
  return rd
}

/**
 * Append one completion. Returns the advanced write index, or null when the
 * ring is too full to take it — in which case nothing was written and the
 * caller must retry rather than half-publish a record.
 */
export function writeCompletion(
  heap: Uint8Array,
  view: DataView,
  base: number,
  size: number,
  wr: number,
  rd: number,
  token: number,
  flags: number,
  payload: Uint8Array | null,
): number | null {
  const inLen = payload?.length ?? 0
  const rec = CMP_HDR + align4(inLen)
  let off = wr % size
  const pad = size - off < rec ? size - off : 0
  const used = (wr - rd) >>> 0
  if (size - used < pad + rec) return null

  if (pad) {
    view.setUint32(base + off, TOKEN_SKIP, true)
    wr = (wr + pad) >>> 0
    off = 0
  }

  view.setUint32(base + off, token, true)
  view.setUint16(base + off + 4, flags, true)
  view.setUint16(base + off + 6, 0, true)
  view.setUint32(base + off + 8, inLen, true)
  if (payload && inLen) heap.set(payload, base + off + CMP_HDR)
  return (wr + rec) >>> 0
}

/**
 * Read the NUL-padded device name out of an area.
 *
 * The `slice` is load-bearing, not defensive copying: under `-pthread` the wasm
 * heap is a SharedArrayBuffer, and `TextDecoder.decode` refuses a view onto
 * shared memory outright ("The provided ArrayBufferView value must not be
 * shared"). `slice` yields a view over an ordinary ArrayBuffer, which it will
 * take.
 */
export function readName(heap: Uint8Array, areaBase: number): string {
  const bytes = heap.slice(areaBase + AREA.name, areaBase + AREA.name + NAME_MAX)
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}
