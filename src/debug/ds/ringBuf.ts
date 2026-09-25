/**
 * Zephyr ring_buf decode (include/zephyr/sys/ring_buffer.h).
 *
 * Default index type is uint16_t; CONFIG_RING_BUFFER_LARGE widens to uint32_t.
 * We try the uint16 layout first and fall back when indices look nonsense.
 */

import {
  type MemoryReader,
  type PtrWidth,
  looksLikePtr,
  readBytes,
  readPtr,
  readU16,
  readU32,
} from '@/debug/ds/mem'

export interface RingIndex {
  head: number
  tail: number
  base: number
}

export interface RingBuf {
  addr: number
  buffer: number
  size: number
  put: RingIndex
  get: RingIndex
  /** Bytes claimed available for get (mod size arithmetic). */
  used: number
  indexWidth: 2 | 4
}

/** Bytes available to read — mirrors `ring_buf_size_get` (put.tail − get.head). */
export function ringUsed(size: number, getHead: number, putTail: number): number {
  if (size === 0) return 0
  const mod = size * 2
  return ((putTail - getHead) % mod + mod) % mod
}

export function ringBufHeaderSize(width: PtrWidth, indexWidth: 2 | 4): number {
  // buffer ptr + put{3} + get{3} + size u32
  // Natural packing: after ptr, indices pack tightly; size at 4-align.
  const idxBlock = indexWidth * 3
  const afterPtr = width
  // put then get contiguous
  const afterIdx = afterPtr + idxBlock * 2
  const sizeOff = (afterIdx + 3) & ~3
  return sizeOff + 4
}

function parseWith(
  bytes: Uint8Array,
  addr: number,
  width: PtrWidth,
  indexWidth: 2 | 4,
): RingBuf | null {
  const need = ringBufHeaderSize(width, indexWidth)
  if (bytes.length < need) return null
  const buffer = readPtr(bytes, 0, width)
  let o: number = width
  const readIdx = (): RingIndex => {
    if (indexWidth === 2) {
      const head = readU16(bytes, o)
      const tail = readU16(bytes, o + 2)
      const base = readU16(bytes, o + 4)
      o += 6
      return { head, tail, base }
    }
    const head = readU32(bytes, o)
    const tail = readU32(bytes, o + 4)
    const base = readU32(bytes, o + 8)
    o += 12
    return { head, tail, base }
  }
  const put = readIdx()
  const get = readIdx()
  o = (o + 3) & ~3
  const size = readU32(bytes, o)
  if (size === 0 || size > 0x0100_0000) return null
  if (!looksLikePtr(buffer, width) && buffer !== 0) return null
  const used = ringUsed(size, get.head, put.tail)
  if (used > size) return null
  // Indices should live in the modular 2*size space.
  const mod = size * 2
  for (const v of [put.tail, get.tail, put.head, get.head]) {
    if (v >= mod) return null
  }
  return {
    addr: addr >>> 0,
    buffer,
    size,
    put,
    get,
    used,
    indexWidth,
  }
}

export async function loadRingBuf(
  read: MemoryReader,
  addr: number,
  width: PtrWidth,
): Promise<{ ring: RingBuf | null; error: string | null }> {
  const need16 = ringBufHeaderSize(width, 2)
  const need32 = ringBufHeaderSize(width, 4)
  const bytes = await readBytes(read, addr, need32)
  const short = bytes && bytes.length >= need16 ? bytes : await readBytes(read, addr, need16)
  if (!short) return { ring: null, error: 'could not read ring_buf' }
  const as16 = parseWith(short, addr, width, 2)
  if (as16) return { ring: as16, error: null }
  if (bytes && bytes.length >= need32) {
    const as32 = parseWith(bytes, addr, width, 4)
    if (as32) return { ring: as32, error: null }
  }
  return { ring: null, error: 'bytes do not look like a ring_buf' }
}
