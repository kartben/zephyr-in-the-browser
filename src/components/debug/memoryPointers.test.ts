import { describe, expect, it } from 'vitest'

import {
  MIN_POINTER,
  decodeWindowPointers,
  pointerBytes,
  pointerRunsByOffset,
} from './memoryPointers'
import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'

const NAMED: Record<number, ResolvedAddress> = {
  0x2000_1a40: { kind: 'object', name: 'uart_msgq', base: 0x2000_1a40, offset: 0, size: 40 },
  0x2000_0c18: { kind: 'object', name: 'blink_thread', base: 0x2000_0c10, offset: 8, size: 128 },
  0x0000_0010: { kind: 'code', name: 'z_early_boot', base: 0x10, offset: 0, size: null },
}

const map: AddressMap = {
  empty: false,
  resolve: (addr) => NAMED[addr] ?? null,
}

/** Little-endian window builder — `words` are 32-bit, laid out from `base`. */
function window(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 4)
  words.forEach((word, i) => {
    for (let b = 0; b < 4; b++) bytes[i * 4 + b] = (word >>> (b * 8)) & 0xff
  })
  return bytes
}

describe('decodeWindowPointers', () => {
  it('links the words that name something and leaves the rest alone', () => {
    const runs = decodeWindowPointers({
      base: 0x2000_1a40,
      bytes: window([0x2000_0c18, 0x0000_0008, 0x2000_1a40, 0x1234_5678]),
      ptrBytes: 4,
      map,
    })
    expect(runs.map((r) => [r.offset, r.target.name, r.self])).toEqual([
      [0, 'blink_thread', false],
      // Points at the head of the window, not at itself — a link, not a loop.
      [8, 'uart_msgq', false],
    ])
  })

  it('marks a word holding its own address as a self-reference', () => {
    const [run] = decodeWindowPointers({
      base: 0x2000_1a40,
      bytes: window([0x2000_1a40]),
      ptrBytes: 4,
      map,
    })
    expect(run!.self).toBe(true)
    expect(run!.target.name).toBe('uart_msgq')
  })

  it('treats small integers as numbers even when they resolve', () => {
    // 0x10 is a real function address on a Cortex-M, and also every plausible
    // count, size and priority in a kernel struct.
    expect(map.resolve(0x10)).not.toBeNull()
    expect(
      decodeWindowPointers({ base: 0x2000_1a40, bytes: window([0x10]), ptrBytes: 4, map }),
    ).toEqual([])
    expect(MIN_POINTER).toBeGreaterThan(0x10)
  })

  it('aligns candidates on the absolute address, not the window offset', () => {
    // Window starts two bytes into a word: the first aligned word is at +2.
    const bytes = new Uint8Array(10)
    bytes.set(window([0x2000_1a40]), 2)
    const runs = decodeWindowPointers({ base: 0x2000_1a3e, bytes, ptrBytes: 4, map })
    expect(runs.map((r) => r.offset)).toEqual([2])
    expect(runs[0]!.addr).toBe(0x2000_1a40)
  })

  it('reads 64-bit words when the guest is 64-bit', () => {
    const bytes = new Uint8Array(8)
    bytes.set(window([0x2000_1a40, 0]))
    const runs = decodeWindowPointers({ base: 0x2000_0000, bytes, ptrBytes: 8, map })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.length).toBe(8)
    expect(runs[0]!.value).toBe(0x2000_1a40)
  })

  it('does nothing without a map', () => {
    expect(
      decodeWindowPointers({ base: 0, bytes: window([0x2000_1a40]), ptrBytes: 4, map: null }),
    ).toEqual([])
  })
})

describe('pointerRunsByOffset', () => {
  it('covers every byte of a run so any of them can follow it', () => {
    const runs = decodeWindowPointers({
      base: 0x2000_1a40,
      bytes: window([0x2000_0c18]),
      ptrBytes: 4,
      map,
    })
    const byOffset = pointerRunsByOffset(runs)
    expect([...byOffset.keys()]).toEqual([0, 1, 2, 3])
    expect(byOffset.get(3)?.target.name).toBe('blink_thread')
  })
})

describe('pointerBytes', () => {
  it('is 8 only on aarch64', () => {
    expect(pointerBytes('aarch64')).toBe(8)
    expect(pointerBytes('arm')).toBe(4)
    expect(pointerBytes('riscv32')).toBe(4)
    expect(pointerBytes(null)).toBe(4)
  })
})
