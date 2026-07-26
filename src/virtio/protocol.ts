/**
 * The wire format shared with `hw/virtio/virtio-browser.c` in the patched QEMU
 * (tools/qemu-jit-patches/0010-*). Keep this in sync with docs/virtio-bridge.md.
 */

export const AREA_MAGIC = 0x47524256
export const AREA_VERSION = 1

/**
 * Byte offsets into `VirtioBrowserArea`; mismatches silently corrupt shared
 * memory reads, so these stay spelled out beside the C struct.
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
export const AREA_BYTES = 144

export const REQ_HDR = 16
export const CMP_HDR = 12

export const TOKEN_SKIP = 0xffffffff

export const CMP_OK = 0x0
export const CMP_FAIL = 0x1

/** Matches VIRTIO_BROWSER_MAX_PAYLOAD; larger records mean a corrupt ring. */
export const MAX_PAYLOAD = 4096

export const align4 = (n: number) => (n + 3) & ~3

export interface RawRequest {
  token: number
  queue: number
  /** Ring view; copy before yielding or advancing req_rd. */
  out: Uint8Array
  inCap: number
}

/**
 * Read complete requests between `rd` and `wr`; `onRequest` receives temporary
 * ring views.
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

    // req_wr is published after the record is whole; overrun means ring corrupt.
    if (outLen > MAX_PAYLOAD || rec > ((wr - rd) >>> 0)) return wr

    const start = base + off + REQ_HDR
    onRequest({ token, queue, out: heap.subarray(start, start + outLen), inCap })
    rd = (rd + rec) >>> 0
  }
  return rd
}

/**
 * Append one completion, or return null without half-publishing when full.
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
 * `slice` is required: TextDecoder refuses SharedArrayBuffer-backed views.
 */
export function readName(heap: Uint8Array, areaBase: number): string {
  const bytes = heap.slice(areaBase + AREA.name, areaBase + AREA.name + NAME_MAX)
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}
