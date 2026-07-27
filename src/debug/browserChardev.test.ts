import { describe, expect, it } from 'vitest'
import { bindChardev, chardevAvailable, drainBytes, feedBytes } from '@/debug/browserChardev'

describe('bindChardev', () => {
  it('maps snake_case Emscripten exports for the gdb slot', () => {
    const feed = () => 0
    const ring = () => 0
    const ring_size = () => 16
    const read_index = () => 0
    const write_index = () => 0
    const set_read_index = () => {}
    const ch = bindChardev(
      {
        _qemu_browser_gdb_feed: feed,
        _qemu_browser_gdb_ring: ring,
        _qemu_browser_gdb_ring_size: ring_size,
        _qemu_browser_gdb_read_index: read_index,
        _qemu_browser_gdb_write_index: write_index,
        _qemu_browser_gdb_set_read_index: set_read_index,
        HEAPU8: new Uint8Array(32),
      },
      'gdb',
    )
    expect(chardevAvailable(ch)).toBe(true)
    expect(ch.feed).toBe(feed)
    expect(ch.ringSize).toBe(ring_size)
    expect(ch.readIndex).toBe(read_index)
  })

  it('does not invent a camelCase ringSize export', () => {
    const ch = bindChardev(
      {
        _qemu_browser_gdb_feed: () => 0,
        _qemu_browser_gdb_ring: () => 0,
        // Deliberately only the wrong camelCase name — must not bind.
        _qemu_browser_gdb_ringSize: () => 99,
        _qemu_browser_gdb_read_index: () => 0,
        _qemu_browser_gdb_write_index: () => 0,
        _qemu_browser_gdb_set_read_index: () => {},
        HEAPU8: new Uint8Array(8),
      },
      'gdb',
    )
    expect(ch.ringSize).toBeUndefined()
    expect(drainBytes(ch).length).toBe(0)
  })
})

describe('feedBytes / drainBytes', () => {
  it('round-trips through a fake ring', () => {
    const size = 16
    const heap = new Uint8Array(64)
    let read = 0
    let write = 0
    const fed: number[] = []

    const ch = {
      feed: (value: number) => {
        fed.push(value)
        return 0
      },
      ring: () => 0,
      ringSize: () => size,
      readIndex: () => read,
      writeIndex: () => write,
      setReadIndex: (value: number) => {
        read = value
      },
      HEAPU8: heap,
    }

    expect(feedBytes(ch, 'Hi')).toBe(true)
    expect(fed).toEqual([72, 105])

    // Simulate QEMU publishing two bytes into the out ring.
    heap[0] = 0x4f // O
    heap[1] = 0x4b // K
    write = 2
    expect(Array.from(drainBytes(ch))).toEqual([0x4f, 0x4b])
    expect(read).toBe(2)
  })
})
