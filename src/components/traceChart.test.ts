import { describe, expect, it } from 'vitest'
import {
  clampPlotX,
  clampYZoom,
  isIdentityYZoom,
  panYZoom,
  screenYToBase,
  timeTickCount,
  viewFromBoxSelection,
  wantsBoxZoom,
  yZoomFromScreenSelection,
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

describe('yZoomFromScreenSelection', () => {
  it('returns null for a short vertical drag', () => {
    expect(yZoomFromScreenSelection(20, 220, 40, 45, null)).toBeNull()
  })

  it('maps a strip into fractions of the plot band', () => {
    // Mid half of a 200px plot (20..220).
    const z = yZoomFromScreenSelection(20, 220, 70, 170, null)
    expect(z).not.toBeNull()
    expect(z!.f0).toBeCloseTo(0.25, 5)
    expect(z!.f1).toBeCloseTo(0.75, 5)
  })

  it('nests through an existing vertical zoom', () => {
    const outer = { f0: 0.25, f1: 0.75 }
    // Screen covers the full visible band → stays on the outer window.
    const nested = yZoomFromScreenSelection(20, 220, 20, 220, outer)
    expect(nested).not.toBeNull()
    expect(nested!.f0).toBeCloseTo(0.25, 5)
    expect(nested!.f1).toBeCloseTo(0.75, 5)
  })
})

describe('screenYToBase / panYZoom', () => {
  it('round-trips identity zoom', () => {
    expect(screenYToBase(120, 20, 220, null)).toBeCloseTo(120, 5)
  })

  it('pans without changing span', () => {
    const next = panYZoom({ f0: 0.2, f1: 0.5 }, 200, 40)
    expect(next.f1 - next.f0).toBeCloseTo(0.3, 5)
    expect(isIdentityYZoom(next)).toBe(false)
  })

  it('clamps a too-tight zoom to a minimum span', () => {
    const z = clampYZoom({ f0: 0.5, f1: 0.501 }, 0.04)
    expect(z.f1 - z.f0).toBeGreaterThanOrEqual(0.04 - 1e-9)
  })
})

describe('timeTickCount', () => {
  it('scales with the plot width', () => {
    expect(timeTickCount(900)).toBe(16)
    expect(timeTickCount(560)).toBe(10)
  })

  it('asks for two ticks at dock and phone widths, not four', () => {
    // 4 labels of ~54px cannot fit 180px; asking for them is what produced a
    // row of overlapping numbers.
    expect(timeTickCount(180)).toBe(3)
    expect(timeTickCount(100)).toBe(2)
    expect(timeTickCount(0)).toBe(2)
  })
})
