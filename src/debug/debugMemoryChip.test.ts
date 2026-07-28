import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createDebugMemoryChip } from '@/debug/debugMemoryChip'

vi.mock('@/debug/control', () => ({
  patchMemoryCache: vi.fn(),
  writeMemory: vi.fn(async () => true),
  readMemory: vi.fn(async () => null),
}))

import * as debug from '@/debug/control'

describe('createDebugMemoryChip', () => {
  beforeEach(() => {
    vi.mocked(debug.patchMemoryCache).mockClear()
    vi.mocked(debug.writeMemory).mockClear()
    vi.mocked(debug.readMemory).mockClear()
  })

  it('exposes the peeked bytes as a HexBacked buffer', () => {
    const chip = createDebugMemoryChip(0x2000_0000, '0102ff20')
    expect(chip.baseAddr).toBe(0x2000_0000)
    expect(chip.decl.size).toBe(4)
    expect([...chip.memory]).toEqual([0x01, 0x02, 0xff, 0x20])
    expect(chip.pointer()).toBe(-1)
  })

  it('bumps version and notifies when apply sees changes', () => {
    const chip = createDebugMemoryChip(0x1000, '00000000')
    const versions: number[] = []
    chip.subscribe(() => versions.push(chip.version()))
    const before = chip.version()
    chip.apply('00000001')
    expect(chip.version()).toBe(before + 1)
    expect([...chip.memory]).toEqual([0, 0, 0, 1])
    expect(versions).toEqual([before + 1])
  })

  it('does not bump version when apply is a no-op', () => {
    const chip = createDebugMemoryChip(0x1000, 'aabb')
    const before = chip.version()
    chip.apply('aabb')
    expect(chip.version()).toBe(before)
  })

  it('pokes a byte, patches the cache, and writes through GDB', async () => {
    const chip = createDebugMemoryChip(0x2000_0100, '0000')
    chip.poke(1, 0x5a)
    expect(chip.memory[1]).toBe(0x5a)
    expect(debug.patchMemoryCache).toHaveBeenCalledWith(0x2000_0101, Uint8Array.of(0x5a))
    await vi.waitFor(() => {
      expect(debug.writeMemory).toHaveBeenCalledWith(0x2000_0101, Uint8Array.of(0x5a))
    })
  })
})
