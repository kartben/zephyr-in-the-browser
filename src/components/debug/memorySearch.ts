/**
 * Byte-pattern search over guest memory (debugger Mem tab).
 *
 * Chunk size is independent of the visible Mem window — bump here only.
 */

/**
 * Bytes per RSP peek while scanning.
 *
 * QEMU's gdbstub caps a whole RSP packet around 4 KiB. `m` replies are hex
 * (2× guest bytes + framing), so guest peeks must stay ≤ ~2 KiB. 1 KiB leaves
 * comfortable room; larger values fail instantly with `E…` and look like
 * "not found".
 */
export const SEARCH_CHUNK_BYTES = 1024

export type SearchDirection = 'forward' | 'backward'

/**
 * Parse a Find box value into bytes.
 * - `"text"` / `'text'` → UTF-8
 * - hex (`de ad`, `deadbeef`, `0xdead`) → bytes
 * - anything else → UTF-8 of the raw trimmed string
 */
export function parseSearchPattern(input: string): Uint8Array | null {
  const t = input.trim()
  if (!t) return null
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    const inner = t.slice(1, -1)
    if (!inner) return null
    return new TextEncoder().encode(inner)
  }
  const hex = t.replace(/^0x/i, '').replace(/[\s,_-]/g, '')
  if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    }
    return out
  }
  return new TextEncoder().encode(t)
}

/** First offset ≥ `from` where `needle` occurs, or -1. */
export function findBytesForward(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  const start = Math.max(0, from)
  outer: for (let i = start; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** Last offset ≤ `from` where `needle` occurs, or -1. */
export function findBytesBackward(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  const start = Math.min(from, hay.length - needle.length)
  outer: for (let i = start; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

export type MemoryReader = (addr: number, length: number) => Promise<Uint8Array | null>

export type ScanProgress = { addr: number }

export type ScanResult =
  | { status: 'hit'; addr: number }
  | { status: 'not_found' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

/**
 * Read `want` bytes, halving on stub errors (packet too big / partial map).
 * Returns null only when even a needle-sized peek fails.
 */
async function readAdaptive(
  read: MemoryReader,
  addr: number,
  want: number,
  minLen: number,
): Promise<Uint8Array | null> {
  let len = want
  while (len >= minLen) {
    const buf = await read(addr, len)
    if (buf && buf.length >= minLen) return buf
    len = Math.floor(len / 2)
  }
  return null
}

/**
 * Scan guest memory for `pattern` starting at `origin` (inclusive on the first
 * call — pass `lastHit ± 1` for find-next).
 */
export async function scanMemory(opts: {
  pattern: Uint8Array
  origin: number
  direction: SearchDirection
  chunkSize?: number
  read: MemoryReader
  signal: AbortSignal
  onProgress?: (p: ScanProgress) => void
}): Promise<ScanResult> {
  const needle = opts.pattern
  if (needle.length === 0) return { status: 'error', message: 'empty pattern' }
  const chunkSize = Math.max(needle.length, opts.chunkSize ?? SEARCH_CHUNK_BYTES)
  const overlap = needle.length - 1
  const step = Math.max(1, chunkSize - overlap)
  const SPACE = 0x1_0000_0000
  /** Skip this far over an unreadable hole so flash/RAM gaps do not abort. */
  const HOLE_SKIP = Math.max(step, 0x1000)

  let cursor = opts.origin >>> 0
  let reads = 0

  while (!opts.signal.aborted) {
    opts.onProgress?.({ addr: cursor })

    if (opts.direction === 'forward') {
      if (cursor > SPACE - needle.length) return { status: 'not_found' }
      const want = Math.min(chunkSize, SPACE - cursor)
      const buf = await readAdaptive(opts.read, cursor, want, needle.length)
      reads++
      if (!buf) {
        if (reads === 1) {
          return { status: 'error', message: 'memory read failed' }
        }
        const next = cursor + HOLE_SKIP
        if (next <= cursor || next >= SPACE) return { status: 'not_found' }
        cursor = next >>> 0
        continue
      }
      const hit = findBytesForward(buf, needle, 0)
      if (hit >= 0) return { status: 'hit', addr: (cursor + hit) >>> 0 }
      if (cursor + buf.length >= SPACE) return { status: 'not_found' }
      const next = cursor + Math.max(1, buf.length - overlap)
      if (next <= cursor) return { status: 'not_found' }
      cursor = next >>> 0
    } else {
      if (cursor < needle.length - 1) return { status: 'not_found' }
      const end = cursor + 1
      const want = Math.min(chunkSize, end)
      const base = end - want
      const buf = await readAdaptive(opts.read, base, want, needle.length)
      reads++
      if (!buf) {
        if (reads === 1) {
          return { status: 'error', message: 'memory read failed' }
        }
        if (base === 0) return { status: 'not_found' }
        const next = base > HOLE_SKIP ? base - HOLE_SKIP : 0
        cursor = next === 0 ? needle.length - 1 : (next - 1) >>> 0
        continue
      }
      const actualBase = end - buf.length
      const fromOff = Math.min(cursor - actualBase, buf.length - needle.length)
      const hit = findBytesBackward(buf, needle, fromOff)
      if (hit >= 0) return { status: 'hit', addr: (actualBase + hit) >>> 0 }
      if (actualBase === 0) return { status: 'not_found' }
      const nextEnd = actualBase + overlap
      if (nextEnd >= end) return { status: 'not_found' }
      cursor = (nextEnd - 1) >>> 0
    }
  }
  return { status: 'cancelled' }
}
