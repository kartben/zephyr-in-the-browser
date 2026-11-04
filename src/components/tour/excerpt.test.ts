import { describe, expect, it } from 'vitest'
import {
  CONTEXT,
  FAR_ROWS,
  MAX_LINES,
  MIN_ROWS,
  PIN_CONTEXT,
  PIN_HIGHLIGHT,
  ROW_PX,
  SKIP_PX,
  excerptWindow,
  openingRows,
  openingScroll,
  pageScroll,
  pinBlocks,
  pinLayout,
} from '@/components/tour/excerpt'

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

describe('pinBlocks', () => {
  it('pins the stop and a highlight with the lines around them', () => {
    expect(pinBlocks(332, 207, [{ start: 85, end: 85 }])).toEqual([
      { start: 85 - PIN_CONTEXT, end: 85 + PIN_CONTEXT },
      { start: 207 - PIN_CONTEXT, end: 207 + PIN_CONTEXT },
    ])
  })

  it('keeps a highlight whole, so a struct keeps its closing brace', () => {
    // The sensor's reading, 144 to 148, and its `};`.
    expect(pinBlocks(332, 154, [{ start: 144, end: 148 }])[0]).toEqual({
      start: 144 - PIN_CONTEXT,
      end: 148 + PIN_CONTEXT,
    })
  })

  it('cuts a highlight too long to pin, and still pins the stop past the cut', () => {
    expect(pinBlocks(1000, 300, [{ start: 1, end: 400 }])).toEqual([
      { start: 1, end: PIN_HIGHLIGHT + PIN_CONTEXT },
      { start: 300 - PIN_CONTEXT, end: 300 + PIN_CONTEXT },
    ])
  })

  it('makes one block of lines that touch', () => {
    // 207 with 210 to 213: 206-208 and 209-214.
    expect(pinBlocks(332, 207, [{ start: 210, end: 213 }])).toEqual([{ start: 206, end: 214 }])
  })

  it('clamps to the file and ignores a backwards range', () => {
    expect(pinBlocks(8, 8, [{ start: 6, end: 3 }])).toEqual([{ start: 7, end: 8 }])
    expect(pinBlocks(8, null)).toEqual([])
  })
})

describe('pinLayout', () => {
  // The sensor pipeline's first step, in a window of 16 rows.
  const blocks = pinBlocks(332, 207, [{ start: 85, end: 85 }])
  const view = 16 * ROW_PX
  const layout = (line: number, viewPx = view) => pinLayout(blocks, (line - 1) * ROW_PX, viewPx, 207)
  const rows = (stack: { start: number; end: number }[]) => stack.map((b) => `${b.start}-${b.end}`)

  it('pins each block to the edge it left by', () => {
    const between = layout(120)
    expect(rows(between.above)).toEqual(['84-86'])
    expect(rows(between.below)).toEqual(['206-208'])

    expect(rows(layout(1).below)).toEqual(['84-86', '206-208'])
    expect(rows(layout(1).above)).toEqual([])
    expect(rows(layout(260).above)).toEqual(['84-86', '206-208'])
    expect(rows(layout(260).below)).toEqual([])
  })

  it('leaves a block in the code while it is in view', () => {
    const on = layout(200)
    expect(rows(on.above)).toEqual(['84-86'])
    expect(rows(on.below)).toEqual([])
    expect(on.above).not.toContainEqual({ start: 206, end: 208 })
  })

  it('sticks a block exactly where it already is, so it does not jump', () => {
    // The block's first line reaches the top edge: it reads the same pinned.
    const at = layout(84)
    expect(rows(at.above)).toEqual(['84-86'])
    expect(at.skipAbove).toBe(false)
    expect(at.topPx).toBe(3 * ROW_PX)
    expect(rows(layout(83).above)).toEqual([])
  })

  it('marks the break once the code under the pins has moved on', () => {
    const on = layout(120)
    expect(on.skipAbove).toBe(true)
    expect(on.skipBelow).toBe(true)
    expect(on.topPx).toBe(3 * ROW_PX + SKIP_PX)
    expect(on.bottomPx).toBe(3 * ROW_PX + SKIP_PX)
    // Two blocks count the mark between them too.
    expect(layout(260).topPx).toBe(6 * ROW_PX + 2 * SKIP_PX)
  })

  it('always leaves code free to scroll, dropping the furthest and keeping the stop', () => {
    const tight = layout(300, 8 * ROW_PX)
    expect(rows(tight.above)).toEqual(['206-208'])
    expect(tight.topPx).toBeLessThanOrEqual(5 * ROW_PX)
    // No room for anything: nothing pinned, as in a test with no layout.
    expect(rows(layout(300, 0).above)).toEqual([])
  })

  it('holds at most two blocks to an edge', () => {
    const many = pinBlocks(500, 400, [
      { start: 10, end: 10 },
      { start: 50, end: 50 },
      { start: 90, end: 90 },
    ])
    const stuck = pinLayout(many, 450 * ROW_PX, 40 * ROW_PX, 400).above
    expect(rows(stuck)).toEqual(['89-91', '399-401'])
  })
})

describe('pageScroll', () => {
  const lineCount = 332
  /** The lines whole and uncovered at one scroll position. */
  const live = (blocks: { start: number; end: number }[], top: number, view: number) => {
    const { topPx, bottomPx } = pinLayout(blocks, top, view, 207)
    const seen: number[] = []
    for (let n = 1; n <= lineCount; n++) {
      const y = (n - 1) * ROW_PX
      if (y >= top + topPx && y + ROW_PX <= top + view - bottomPx) seen.push(n)
    }
    return seen
  }

  const cases = [
    ['the stop and a far highlight', [{ start: 85, end: 85 }]],
    ['a highlight next to the stop', [{ start: 210, end: 213 }]],
    ['no highlight', []],
  ] as const

  for (const [what, ranges] of cases) {
    for (const rows of [8, 16, 30]) {
      it(`reads every line, down and up, with ${what} in ${rows} rows`, () => {
        const blocks = pinBlocks(lineCount, 207, [...ranges])
        const view = rows * ROW_PX
        const maxTop = lineCount * ROW_PX - view
        for (const direction of [1, -1] as const) {
          const seen = new Set<number>()
          let top = direction > 0 ? 0 : maxTop
          for (let page = 0; page <= lineCount; page++) {
            live(blocks, top, view).forEach((n) => seen.add(n))
            if (top === (direction > 0 ? maxTop : 0)) break
            const next = pageScroll(blocks, top, view, maxTop, direction, 207)
            expect(direction > 0 ? next > top : next < top).toBe(true)
            top = next
          }
          expect(top).toBe(direction > 0 ? maxTop : 0)
          const skipped = Array.from({ length: lineCount }, (_, i) => i + 1).filter((n) => !seen.has(n))
          expect(skipped).toEqual([])
        }
      })
    }
  }
})

describe('opening a window', () => {
  const liveTop = (line: number, ranges: { start: number; end: number }[], viewPx: number) => {
    const top = openingScroll(332, line, ranges, viewPx)
    const { topPx, bottomPx } = pinLayout(pinBlocks(332, line, ranges), top, viewPx, line)
    return { top, topPx, bottomPx, y: (line - 1) * ROW_PX - top }
  }

  it('opens on the lines the step would have shown, when they share a window', () => {
    // Stop on 154, the reading from 144: the excerpt was 141 to 157.
    const ranges = [{ start: 144, end: 148 }]
    expect(openingRows(332, 154, ranges)).toBe(17)
    expect(openingScroll(332, 154, ranges, 17 * ROW_PX)).toBe((141 - 1) * ROW_PX)
  })

  it('gives a bare stop some room to look around', () => {
    expect(openingRows(332, 207)).toBe(MIN_ROWS)
    const top = openingScroll(332, 207, [], MIN_ROWS * ROW_PX)
    expect(top).toBeLessThanOrEqual((207 - 1) * ROW_PX)
    expect(top + MIN_ROWS * ROW_PX).toBeGreaterThanOrEqual(207 * ROW_PX)
  })

  it('grows by what the pins take, when the stop and the highlight are far apart', () => {
    const ranges = [{ start: 85, end: 85 }]
    expect(openingRows(332, 207, ranges)).toBe(FAR_ROWS + 2 * PIN_CONTEXT)
    const view = openingRows(332, 207, ranges) * ROW_PX
    const { top, topPx, bottomPx, y } = liveTop(207, ranges, view)
    expect(y).toBeGreaterThanOrEqual(topPx)
    expect(y + ROW_PX).toBeLessThanOrEqual(view - bottomPx)
    // On a whole line under the pins, rather than half of one.
    expect((top + topPx) % ROW_PX).toBe(0)
  })

  it('keeps the far highlight visible at a pin, below the stop as well as above', () => {
    const ranges = [{ start: 300, end: 300 }]
    const view = openingRows(332, 50, ranges) * ROW_PX
    const top = openingScroll(332, 50, ranges, view)
    expect(pinLayout(pinBlocks(332, 50, ranges), top, view, 50).below).toEqual([{ start: 299, end: 301 }])
  })

  it('opens on the first highlight when there is no stop in this file', () => {
    const ranges = [{ start: 40, end: 43 }]
    const view = openingRows(100, null, ranges) * ROW_PX
    const top = openingScroll(100, null, ranges, view)
    expect(top).toBeLessThanOrEqual((40 - 1) * ROW_PX)
    expect(top + view).toBeGreaterThanOrEqual(43 * ROW_PX)
  })

  it('stays in the file, and is no taller than a short one', () => {
    expect(openingRows(5, 2)).toBe(5)
    expect(openingScroll(5, 2, [], 5 * ROW_PX)).toBe(0)
    expect(openingScroll(332, 330, [], MIN_ROWS * ROW_PX)).toBe((332 - MIN_ROWS) * ROW_PX)
  })
})
