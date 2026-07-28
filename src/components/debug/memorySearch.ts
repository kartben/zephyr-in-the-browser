/**
 * Byte-pattern search over guest memory (debugger Mem tab).
 *
 * Chunk size is {@link SEARCH_CHUNK_BYTES} — keep it shared with the visible
 * window for now; bump later without touching the UI.
 */

import { WINDOW_BYTES } from '@/components/debug/memoryView'

/** Bytes per RSP peek while scanning. Same as the Mem window today. */
export const SEARCH_CHUNK_BYTES = WINDOW_BYTES

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

/**
 * Scan guest memory for `pattern` starting at `origin` (inclusive on the first
 * call — pass `lastHit ± 1` for find-next). Returns the absolute hit address,
 * or null if cancelled / exhausted the 32-bit space / read failed.
 */
export async function scanMemory(opts: {
  pattern: Uint8Array
  origin: number
  direction: SearchDirection
  chunkSize?: number
  read: MemoryReader
  signal: AbortSignal
  onProgress?: (p: ScanProgress) => void
}): Promise<number | null> {
  const needle = opts.pattern
  if (needle.length === 0) return null
  const chunkSize = Math.max(needle.length, opts.chunkSize ?? SEARCH_CHUNK_BYTES)
  const overlap = needle.length - 1
  const step = Math.max(1, chunkSize - overlap)
  const SPACE = 0x1_0000_0000

  let cursor = opts.origin >>> 0

  while (!opts.signal.aborted) {
    opts.onProgress?.({ addr: cursor })

    if (opts.direction === 'forward') {
      if (cursor > SPACE - needle.length) return null
      const len = Math.min(chunkSize, SPACE - cursor)
      const buf = await opts.read(cursor, len)
      if (!buf || buf.length < needle.length) return null
      const hit = findBytesForward(buf, needle, 0)
      if (hit >= 0) return (cursor + hit) >>> 0
      if (cursor + len >= SPACE) return null
      const next = cursor + step
      if (next <= cursor) return null
      cursor = next >>> 0
    } else {
      if (cursor < needle.length - 1) return null
      const end = cursor + 1 // exclusive
      const len = Math.min(chunkSize, end)
      const base = end - len
      const buf = await opts.read(base, len)
      if (!buf || buf.length < needle.length) return null
      const fromOff = Math.min(cursor - base, buf.length - needle.length)
      const hit = findBytesBackward(buf, needle, fromOff)
      if (hit >= 0) return (base + hit) >>> 0
      if (base === 0) return null
      const nextEnd = base + overlap
      if (nextEnd >= end) return null
      cursor = (nextEnd - 1) >>> 0
    }
  }
  return null
}
