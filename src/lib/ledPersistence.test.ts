import { describe, expect, it } from 'vitest'
import {
  LED_PERSISTENCE_TAU_S,
  integrateLedPersistence,
  ledGlowOpacity,
  ledIsLit,
  pwmElectricalOn,
  stepLedPersistence,
} from './ledPersistence'

describe('pwmElectricalOn', () => {
  const T = 20_000_000 // 50 Hz

  it('is off for full-off / zero duty and on for full-on / 100%', () => {
    expect(pwmElectricalOn(0, T, 0.5, false, true)).toBe(false)
    expect(pwmElectricalOn(0, T, 0)).toBe(false)
    expect(pwmElectricalOn(0, T, 0.5, true, false)).toBe(true)
    expect(pwmElectricalOn(0, T, 1)).toBe(true)
  })

  it('follows duty within a period', () => {
    expect(pwmElectricalOn(0, T, 0.25)).toBe(true)
    expect(pwmElectricalOn(T * 0.24, T, 0.25)).toBe(true)
    expect(pwmElectricalOn(T * 0.25, T, 0.25)).toBe(false)
    expect(pwmElectricalOn(T * 0.99, T, 0.25)).toBe(false)
    expect(pwmElectricalOn(T, T, 0.25)).toBe(true)
  })
})

describe('stepLedPersistence', () => {
  it('moves one tau toward the target', () => {
    const risen = stepLedPersistence(0, true, LED_PERSISTENCE_TAU_S)
    expect(risen).toBeCloseTo(1 - Math.exp(-1), 5)

    const fallen = stepLedPersistence(1, false, LED_PERSISTENCE_TAU_S)
    expect(fallen).toBeCloseTo(Math.exp(-1), 5)
  })

  it('snaps residual glow to fully dark', () => {
    expect(stepLedPersistence(1e-5, false, 0.05)).toBe(0)
  })
})

describe('integrateLedPersistence', () => {
  /** Sample perceived brightness over many PWM periods at ~60 Hz UI frames. */
  function breatheRange(periodNs: number, duty: number, frames = 120) {
    const frameNs = 1e9 / 60
    let v = 0
    let t = 0
    let min = Infinity
    let max = -Infinity
    let sum = 0
    // Warm up past the initial transient.
    for (let i = 0; i < frames; i++) {
      v = integrateLedPersistence(v, t, t + frameNs, periodNs, duty)
      t += frameNs
    }
    for (let i = 0; i < frames; i++) {
      v = integrateLedPersistence(v, t, t + frameNs, periodNs, duty)
      t += frameNs
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    return { min, max, mean: sum / frames, swing: max - min }
  }

  it('breathes clearly at 50 Hz mid duty (PWM_MSEC(20))', () => {
    const { swing, max, min } = breatheRange(20_000_000, 0.5)
    // Analytic envelope at τ = 10 ms, T/2 = 10 ms: ~0.27…0.73.
    expect(swing).toBeGreaterThan(0.35)
    expect(max).toBeGreaterThan(0.65)
    expect(min).toBeLessThan(0.4)
  })

  it('averages nearly flat at 1 kHz mid duty', () => {
    const { swing, mean } = breatheRange(1_000_000, 0.5)
    expect(swing).toBeLessThan(0.12)
    expect(mean).toBeGreaterThan(0.4)
    expect(mean).toBeLessThan(0.6)
  })

  it('tracks full-off to dark and full-on to bright', () => {
    let v = 0.5
    v = integrateLedPersistence(v, 0, 100_000_000, 20_000_000, 0.5, false, true)
    expect(v).toBe(0)
    v = integrateLedPersistence(0, 0, 100_000_000, 20_000_000, 0.5, true, false)
    expect(v).toBe(1)
  })
})

describe('ledGlowOpacity / ledIsLit', () => {
  it('matches the prior duty→opacity floor', () => {
    expect(ledIsLit(0.02)).toBe(false)
    expect(ledIsLit(0.021)).toBe(true)
    expect(ledGlowOpacity(0)).toBe(0)
    expect(ledGlowOpacity(1)).toBeCloseTo(1, 5)
    expect(ledGlowOpacity(0.5)).toBeCloseTo(0.65, 5)
  })
})
