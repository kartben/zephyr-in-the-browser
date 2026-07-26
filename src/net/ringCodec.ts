/**
 * QEMU browser-net SPSC ring records:
 *   u16le len | u16le flags | payload[len] | pad to 4
 * Records never wrap; len 0xffff skips the consumer to the next lap.
 */

export const RING_HDR = 4
export const RING_LEN_SKIP = 0xffff
export const RING_MIN_FRAME = 14
export const RING_MAX_FRAME = 1522

const align4 = (n: number) => (n + 3) & ~3

export function ringDrain(
  heap: Uint8Array,
  base: number,
  size: number,
  rd: number,
  wr: number,
  onFrame: (frame: Uint8Array) => void,
): number {
  while (rd !== wr) {
    const off = rd % size
    const len = heap[base + off] | (heap[base + off + 1] << 8)
    if (len === RING_LEN_SKIP) {
      rd = (rd + (size - off)) >>> 0
      continue
    }
    if (len < RING_MIN_FRAME || len > RING_MAX_FRAME) {
      return wr // corrupt record: resync by discarding the lap
    }
    // Copy out: the ring is shared memory and will be overwritten.
    onFrame(heap.slice(base + off + RING_HDR, base + off + RING_HDR + len))
    rd = (rd + RING_HDR + align4(len)) >>> 0
  }
  return rd
}

export function ringWrite(
  heap: Uint8Array,
  base: number,
  size: number,
  wr: number,
  rd: number,
  frame: Uint8Array,
): number | null {
  if (frame.length < RING_MIN_FRAME || frame.length > RING_MAX_FRAME) return wr // count-and-drop
  const rec = RING_HDR + align4(frame.length)
  let off = wr % size
  const pad = size - off < rec ? size - off : 0
  const used = (wr - rd) >>> 0
  if (size - used < pad + rec) return null

  if (pad) {
    heap[base + off] = RING_LEN_SKIP & 0xff
    heap[base + off + 1] = RING_LEN_SKIP >> 8
    heap[base + off + 2] = 0
    heap[base + off + 3] = 0
    wr = (wr + pad) >>> 0
    off = 0
  }
  heap[base + off] = frame.length & 0xff
  heap[base + off + 1] = frame.length >> 8
  heap[base + off + 2] = 0
  heap[base + off + 3] = 0
  heap.set(frame, base + off + RING_HDR)
  return (wr + rec) >>> 0
}
