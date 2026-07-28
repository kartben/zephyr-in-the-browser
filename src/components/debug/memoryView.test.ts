import { describe, expect, it } from 'vitest'

import { formatHexDump } from './formatHexDump'
import {
  BYTES_PER_ROW,
  VISIBLE_ROWS,
  WINDOW_BYTES,
  scrollMemoryAddr,
  wheelRowDelta,
} from './memoryView'

describe('memoryView', () => {
  it('sizes the window to 16 rows of 16 bytes', () => {
    expect(WINDOW_BYTES).toBe(256)
    expect(BYTES_PER_ROW * VISIBLE_ROWS).toBe(WINDOW_BYTES)
  })

  it('scrolls by whole rows and clamps at zero', () => {
    expect(scrollMemoryAddr(0x100, 1)).toBe(0x110)
    expect(scrollMemoryAddr(0x100, -1)).toBe(0xf0)
    expect(scrollMemoryAddr(0x10, -2)).toBe(0)
    expect(scrollMemoryAddr(0x04, 0)).toBe(0x0)
  })

  it('aligns unaligned tops down to a row boundary', () => {
    expect(scrollMemoryAddr(0x108, 1)).toBe(0x110)
    expect(scrollMemoryAddr(0x10f, -1)).toBe(0xf0)
  })

  it('does not wrap past the top of a 32-bit space', () => {
    expect(scrollMemoryAddr(0xffffff00, 1)).toBe(0xffffff00)
    expect(scrollMemoryAddr(0xffffff00, VISIBLE_ROWS)).toBe(0xffffff00)
    expect(scrollMemoryAddr(0xfffffff0, 1)).toBe(0xffffff00)
  })

  it('maps wheel deltas to whole rows', () => {
    expect(wheelRowDelta(100, 0)).toBe(3)
    expect(wheelRowDelta(-20, 0)).toBe(-1)
    expect(wheelRowDelta(2, 1)).toBe(2)
    expect(wheelRowDelta(-1, 1)).toBe(-1)
    expect(wheelRowDelta(1, 2)).toBe(VISIBLE_ROWS)
  })
})

describe('formatHexDump', () => {
  it('renders a full 16-row window as 16 lines', () => {
    const hex = '00'.repeat(WINDOW_BYTES)
    const lines = formatHexDump(0, hex).split('\n')
    expect(lines).toHaveLength(VISIBLE_ROWS)
    expect(lines[0]).toMatch(/^00000000  /)
    expect(lines[15]).toMatch(/^000000f0  /)
  })
})
