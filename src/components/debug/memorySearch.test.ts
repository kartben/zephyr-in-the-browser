import { describe, expect, it } from 'vitest'

import {
  findBytesBackward,
  findBytesForward,
  parseSearchPattern,
  scanMemory,
} from './memorySearch'

describe('parseSearchPattern', () => {
  it('parses hex with spaces or contiguous digits', () => {
    expect([...parseSearchPattern('de ad be ef')!]).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect([...parseSearchPattern('0xDEAD')!]).toEqual([0xde, 0xad])
  })

  it('parses quoted ASCII', () => {
    expect([...parseSearchPattern('"Hi"')!]).toEqual([0x48, 0x69])
    expect([...parseSearchPattern("'x'")!]).toEqual([0x78])
  })

  it('treats bare text as UTF-8', () => {
    expect([...parseSearchPattern('OK')!]).toEqual([0x4f, 0x4b])
  })

  it('rejects empty', () => {
    expect(parseSearchPattern('')).toBeNull()
    expect(parseSearchPattern('""')).toBeNull()
  })
})

describe('findBytes', () => {
  const hay = Uint8Array.of(0x00, 0x11, 0x22, 0x11, 0x22, 0x33)

  it('finds forward and respects from', () => {
    expect(findBytesForward(hay, Uint8Array.of(0x11, 0x22))).toBe(1)
    expect(findBytesForward(hay, Uint8Array.of(0x11, 0x22), 2)).toBe(3)
    expect(findBytesForward(hay, Uint8Array.of(0xff))).toBe(-1)
  })

  it('finds backward and respects from', () => {
    expect(findBytesBackward(hay, Uint8Array.of(0x11, 0x22), 5)).toBe(3)
    expect(findBytesBackward(hay, Uint8Array.of(0x11, 0x22), 2)).toBe(1)
  })
})

describe('scanMemory', () => {
  it('scans forward across chunk boundaries with overlap', async () => {
    // Pattern straddles 4|5 — chunk size 4 needs overlap to catch it.
    const mem = Uint8Array.of(0, 1, 2, 3, 0xaa, 0xbb, 6, 7)
    const read = async (addr: number, len: number) => mem.subarray(addr, addr + len)
    const hit = await scanMemory({
      pattern: Uint8Array.of(0xaa, 0xbb),
      origin: 0,
      direction: 'forward',
      chunkSize: 4,
      read,
      signal: new AbortController().signal,
    })
    expect(hit).toBe(4)
  })

  it('scans backward', async () => {
    const mem = Uint8Array.of(0, 0xaa, 0xbb, 3, 0xaa, 0xbb, 6)
    const read = async (addr: number, len: number) => mem.subarray(addr, addr + len)
    const hit = await scanMemory({
      pattern: Uint8Array.of(0xaa, 0xbb),
      origin: 6,
      direction: 'backward',
      chunkSize: 4,
      read,
      signal: new AbortController().signal,
    })
    expect(hit).toBe(4)
  })

  it('stops when aborted', async () => {
    const ac = new AbortController()
    let reads = 0
    const read = async (_addr: number, len: number) => {
      reads++
      if (reads === 2) ac.abort()
      return new Uint8Array(len)
    }
    const hit = await scanMemory({
      pattern: Uint8Array.of(0xff),
      origin: 0,
      direction: 'forward',
      chunkSize: 4,
      read,
      signal: ac.signal,
    })
    expect(hit).toBeNull()
    expect(reads).toBeGreaterThanOrEqual(2)
  })
})
