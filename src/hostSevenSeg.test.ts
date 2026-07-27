import { beforeEach, describe, expect, it, vi } from 'vitest'

const outputs = { word: 0 }
const displays: Array<{
  id: string
  label: string
  columns: number
  rows: number
  refreshPeriodMs: number
  segments: Array<{ id: number; activeHigh: boolean }>
  digits: Array<{ id: number; activeHigh: boolean }>
}> = [
  {
    id: '/digi-display',
    label: '7-segment LED',
    columns: 3,
    rows: 1,
    refreshPeriodMs: 1,
    segments: [8, 9, 10, 11, 12, 13, 14, 15].map((id) => ({ id, activeHigh: false })),
    digits: [5, 6, 7].map((id) => ({ id, activeHigh: true })),
  },
]

vi.mock('@/hostGpio', () => ({
  getSevenSegs: () => displays,
  isOutputHigh: (pin: number) => (outputs.word & (1 << pin)) !== 0,
  subscribe: (fn: () => void) => {
    // Re-export is wired at module load; tests call refreshForTest instead.
    void fn
    return () => {}
  },
}))

const { getSnapshot, refreshForTest } = await import('@/hostSevenSeg')

/** Drive a digit common high and segments as active-low (0 = lit). */
function frame(digitPin: number, segmentMask: number) {
  let word = 1 << digitPin
  for (let i = 0; i < 8; i++) {
    const pin = 8 + i
    const lit = (segmentMask & (1 << i)) !== 0
    if (!lit) word |= 1 << pin // active-low: dark = high
  }
  outputs.word = word
  refreshForTest()
}

describe('hostSevenSeg latch', () => {
  beforeEach(() => {
    outputs.word = 0
    refreshForTest()
  })

  it('latches each digit when its common is selected', () => {
    // Digit "8." = all segments + DP
    frame(5, 0xff)
    expect(getSnapshot().displays[0]!.digits[0]).toBe(0xff)
    expect(getSnapshot().displays[0]!.active[0]).toBe(true)

    // Digit "1" = B|C
    frame(6, 0x06)
    expect(getSnapshot().displays[0]!.digits[0]).toBe(0xff) // still latched
    expect(getSnapshot().displays[0]!.digits[1]).toBe(0x06)
    expect(getSnapshot().displays[0]!.active[1]).toBe(true)
    expect(getSnapshot().displays[0]!.active[0]).toBe(false)

    // Blank third digit
    frame(7, 0x00)
    expect(getSnapshot().displays[0]!.digits).toEqual([0xff, 0x06, 0x00])
  })
})
