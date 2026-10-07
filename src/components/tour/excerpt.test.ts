import { describe, expect, it } from 'vitest'
import { CONTEXT, MAX_LINES, excerptRows, excerptWindow } from '@/components/tour/excerpt'

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

  it('shows the stop and a far highlight as two windows rather than dropping the stop', () => {
    // A step that stops deep in a long function and points at the definition
    // near the top: one capped window from the top lost the line it stopped on.
    const far = excerptWindow(200, 120, [{ start: 10, end: 12 }])
    expect(far.runs).toEqual([
      { start: 10 - CONTEXT, end: 12 + CONTEXT },
      { start: 120 - CONTEXT, end: 120 + CONTEXT },
    ])
    expect(lines(far)).toEqual([10, 11, 12])

    // A runaway highlight around a stop near its end still shows the stop.
    const runaway = excerptWindow(1000, 300, [{ start: 1, end: 400 }])
    expect(runaway.runs).toHaveLength(1)
    expect(runaway.start).toBeLessThanOrEqual(300)
    expect(runaway.end).toBeGreaterThanOrEqual(300 + CONTEXT)
    expect(runaway.end - runaway.start + 1).toBeLessThanOrEqual(MAX_LINES)
  })

  it('clamps to the file and ignores a backwards range', () => {
    const e = excerptWindow(8, 2, [{ start: 6, end: 3 }])
    expect(e.start).toBe(1)
    expect(e.end).toBe(2 + CONTEXT)
    expect(lines(e)).toEqual([])
  })

  it('windows around highlights when there is no stop in this file', () => {
    const e = excerptWindow(100, null, [{ start: 40, end: 43 }])
    expect(e.start).toBe(40 - CONTEXT)
    expect(e.end).toBe(43 + CONTEXT)
    expect(lines(e)).toEqual([40, 41, 42, 43])
    expect(e.marked(39)).toBe(false)
  })

  it('keeps a stop and a far one-line highlight to a few lines each', () => {
    // The sensor pipeline's first step: K_MSGQ_DEFINE on 85, the stop on 207.
    const e = excerptWindow(332, 207, [{ start: 85, end: 85 }])
    expect(e.runs).toEqual([
      { start: 85 - CONTEXT, end: 85 + CONTEXT },
      { start: 207 - CONTEXT, end: 207 + CONTEXT },
    ])
  })

  it('shares one window only while it fits the ceiling', () => {
    // From the highlight's first line of context to the stop's last.
    const furthest = 60 + 2 * CONTEXT + 1 - MAX_LINES
    const fits = excerptWindow(200, 60, [{ start: furthest, end: furthest }])
    expect(fits.runs).toEqual([{ start: furthest - CONTEXT, end: 60 + CONTEXT }])
    expect(fits.end - fits.start + 1).toBe(MAX_LINES)
    expect(excerptWindow(200, 60, [{ start: furthest - 1, end: furthest - 1 }]).runs).toHaveLength(2)
  })
})

describe('excerptRows', () => {
  const runs = [
    { start: 82, end: 88 },
    { start: 204, end: 210 },
  ]
  const kinds = (rows: ReturnType<typeof excerptRows>) =>
    rows.map((row) =>
      row.kind === 'line' ? row.line : `fold ${row.from}-${row.to}${row.open ? ' open' : ''}`,
    )

  it('puts one fold row between two runs', () => {
    expect(kinds(excerptRows(runs))).toEqual([
      82, 83, 84, 85, 86, 87, 88, 'fold 89-203', 204, 205, 206, 207, 208, 209, 210,
    ])
  })

  it('keeps an opened fold row above the lines it held', () => {
    const rows = kinds(excerptRows(runs, new Set([89])))
    expect(rows.slice(6, 10)).toEqual([88, 'fold 89-203 open', 89, 90])
    expect(rows).toHaveLength(7 + 1 + 115 + 7)
    expect(rows[rows.length - 1]).toBe(210)
  })

  it('draws one run with no fold, and nothing for no runs', () => {
    expect(kinds(excerptRows([{ start: 5, end: 7 }]))).toEqual([5, 6, 7])
    expect(excerptRows([])).toEqual([])
  })
})
