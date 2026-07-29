import { describe, expect, it } from 'vitest'
import { CONTEXT, MAX_LINES, excerptWindow } from '@/components/tour/excerpt'

const lines = (e: ReturnType<typeof excerptWindow>) =>
  Array.from({ length: e.end - e.start + 1 }, (_, i) => e.start + i).filter((n) => e.marked(n))

describe('excerptWindow', () => {
  it('centres on the stop line when nothing is highlighted', () => {
    const e = excerptWindow(100, 40)
    expect([e.start, e.end]).toEqual([40 - CONTEXT, 40 + CONTEXT])
    expect(lines(e)).toEqual([])
  })

  it('stretches back to reach a highlight above the stop', () => {
    // blinky: stops at the top of main(), points at the declaration far above.
    const e = excerptWindow(100, 28, [{ start: 21, end: 21 }])
    expect(e.start).toBe(21 - CONTEXT)
    expect(e.end).toBeGreaterThanOrEqual(28)
    expect(lines(e)).toEqual([21])
  })

  it('covers several ranges and marks each of them', () => {
    const e = excerptWindow(100, 32, [
      { start: 28, end: 30 },
      { start: 32, end: 35 },
    ])
    expect(lines(e)).toEqual([28, 29, 30, 32, 33, 34, 35])
  })

  it('keeps the stop line even when the highlight is elsewhere', () => {
    const e = excerptWindow(100, 60, [{ start: 58, end: 59 }])
    expect(e.start).toBeLessThanOrEqual(60)
    expect(e.end).toBeGreaterThanOrEqual(60)
    expect(e.marked(60)).toBe(false) // stop is not a highlight
  })

  it('caps a runaway highlight instead of filling the card', () => {
    const e = excerptWindow(1000, 10, [{ start: 1, end: 400 }])
    expect(e.end - e.start + 1).toBeLessThanOrEqual(MAX_LINES)
  })

  it('clamps to the file and ignores a backwards range', () => {
    const e = excerptWindow(8, 2, [{ start: 6, end: 3 }])
    expect(e.start).toBe(1)
    expect(e.end).toBe(7)
    expect(lines(e)).toEqual([])
  })
})
