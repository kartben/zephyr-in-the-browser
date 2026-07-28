import { describe, expect, it } from 'vitest'
import {
  clampPlotX,
  viewFromBoxSelection,
  wantsBoxZoom,
} from './traceChart'

describe('wantsBoxZoom', () => {
  it('uses Shift to arm box zoom when sticky mode is off', () => {
    expect(wantsBoxZoom(false, false)).toBe(false)
    expect(wantsBoxZoom(true, false)).toBe(true)
  })

  it('inverts with Shift when sticky box-zoom mode is on', () => {
    expect(wantsBoxZoom(false, true)).toBe(true)
    expect(wantsBoxZoom(true, true)).toBe(false)
  })
})

describe('clampPlotX', () => {
  it('clamps into the plot strip', () => {
    expect(clampPlotX(0, 200, 40, 8)).toBe(40)
    expect(clampPlotX(100, 200, 40, 8)).toBe(100)
    expect(clampPlotX(400, 200, 40, 8)).toBe(192)
  })
})

describe('viewFromBoxSelection', () => {
  const view = { t0: 1_000_000, t1: 2_000_000 }

  it('returns null for a short drag', () => {
    expect(viewFromBoxSelection(view, 200, 40, 8, 50, 55)).toBeNull()
  })

  it('maps the selected pixels onto the current window', () => {
    // Plot spans x=40..192 over 1ms of time.
    const next = viewFromBoxSelection(view, 200, 40, 8, 40, 192)
    expect(next).not.toBeNull()
    expect(next!.t0).toBeCloseTo(view.t0, 0)
    expect(next!.t1).toBeCloseTo(view.t1, 0)
  })

  it('ignores drag direction', () => {
    const a = viewFromBoxSelection(view, 200, 40, 8, 40, 116)
    const b = viewFromBoxSelection(view, 200, 40, 8, 116, 40)
    expect(a).toEqual(b)
  })
})
