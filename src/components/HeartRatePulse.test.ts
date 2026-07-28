import { describe, expect, it } from 'vitest'
import { ecgSample, heartScale } from './HeartRatePulse'

describe('ecgSample', () => {
  it('is quiet on the isoelectric baseline', () => {
    expect(ecgSample(0)).toBe(0)
    expect(ecgSample(0.7)).toBe(0)
    expect(ecgSample(0.99)).toBe(0)
  })

  it('peaks near the R wave', () => {
    const r = ecgSample(0.205)
    expect(r).toBeGreaterThan(0.85)
    expect(r).toBeGreaterThan(ecgSample(0.08)) // P
    expect(r).toBeGreaterThan(ecgSample(0.43)) // T
  })

  it('wraps phase into [0, 1)', () => {
    expect(ecgSample(1.205)).toBeCloseTo(ecgSample(0.205), 8)
    expect(ecgSample(-0.795)).toBeCloseTo(ecgSample(0.205), 8)
  })
})

describe('heartScale', () => {
  it('rests near 1 between beats', () => {
    expect(heartScale(0.6)).toBeCloseTo(1, 3)
  })

  it('swells on the lub and again on the softer dub', () => {
    const lub = heartScale(0.18)
    const dub = heartScale(0.3)
    const rest = heartScale(0.7)
    expect(lub).toBeGreaterThan(1.2)
    expect(dub).toBeGreaterThan(1.08)
    expect(lub).toBeGreaterThan(dub)
    expect(rest).toBeLessThan(lub)
  })
})
