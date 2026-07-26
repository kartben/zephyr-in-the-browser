/**
 * Perceived LED brightness under PWM, modelled as first-order eye/display
 * persistence so low-frequency PWM ripples and kHz PWM averages to duty.
 */

export const LED_PERSISTENCE_TAU_S = 0.01

export function pwmElectricalOn(
  timeNs: number,
  periodNs: number,
  duty: number,
  fullOn = false,
  fullOff = false,
): boolean {
  if (fullOff || duty <= 0) return false
  if (fullOn || duty >= 1) return true
  if (!(periodNs > 0) || !Number.isFinite(periodNs)) return duty > 0
  const phase = ((timeNs % periodNs) + periodNs) % periodNs
  return phase < periodNs * duty
}

/** Exact exponential step toward on (1) or off (0). */
export function stepLedPersistence(
  value: number,
  on: boolean,
  dtSec: number,
  riseTau = LED_PERSISTENCE_TAU_S,
  fallTau = LED_PERSISTENCE_TAU_S,
): number {
  if (!(dtSec > 0) || !Number.isFinite(dtSec)) return value
  const target = on ? 1 : 0
  const tau = on ? riseTau : fallTau
  if (!(tau > 0)) return target
  const alpha = Math.exp(-dtSec / tau)
  const next = target + (value - target) * alpha
  // Snap tiny residuals so idle LEDs can go fully dark.
  if (!on && next < 1e-4) return 0
  if (on && next > 1 - 1e-4) return 1
  return next
}

/** Integrate exact PWM segments over [t0Ns, t1Ns), avoiding display-frame aliasing. */
export function integrateLedPersistence(
  value: number,
  t0Ns: number,
  t1Ns: number,
  periodNs: number,
  duty: number,
  fullOn = false,
  fullOff = false,
  riseTau = LED_PERSISTENCE_TAU_S,
  fallTau = LED_PERSISTENCE_TAU_S,
): number {
  if (!(t1Ns > t0Ns)) return value

  if (fullOff || duty <= 0) {
    return stepLedPersistence(value, false, (t1Ns - t0Ns) / 1e9, riseTau, fallTau)
  }
  if (fullOn || duty >= 1 || !(periodNs > 0) || !Number.isFinite(periodNs)) {
    return stepLedPersistence(value, true, (t1Ns - t0Ns) / 1e9, riseTau, fallTau)
  }

  let v = value
  let t = t0Ns
  const pulseNs = periodNs * Math.max(0, Math.min(1, duty))
  // Cap segments: worst case ~2 edges/period over a long catch-up window.
  let guard = 0
  while (t < t1Ns && guard++ < 256) {
    const phase = ((t % periodNs) + periodNs) % periodNs
    const on = phase < pulseNs
    const nextEdgeInPeriod = on ? pulseNs : periodNs
    // At least 1 ns so float ties on an edge cannot stall the loop.
    const toEdge = Math.max(1, nextEdgeInPeriod - phase)
    const segmentEnd = Math.min(t1Ns, t + toEdge)
    v = stepLedPersistence(v, on, (segmentEnd - t) / 1e9, riseTau, fallTau)
    t = segmentEnd
  }
  return v
}

export function ledGlowOpacity(perceived: number): number {
  const v = Math.max(0, Math.min(1, perceived))
  if (v <= 0.02) return 0
  return 0.3 + 0.7 * v
}

export function ledIsLit(perceived: number): boolean {
  return perceived > 0.02
}
