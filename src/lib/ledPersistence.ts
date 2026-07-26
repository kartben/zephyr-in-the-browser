/**
 * Perceived LED brightness under PWM — first-order persistence.
 *
 * Real LED dies switch in nanoseconds; what the eye (and this UI) sees is a
 * short integration of that square wave. Model it as a single exponential
 * low-pass so a ~50 Hz period still ripples ("breathes") while kHz PWM
 * averages to a steady glow at roughly the programmed duty.
 *
 * τ is eye-scale (~10 ms), not die-scale. At T = 20 ms and mid duty the
 * envelope swings ~0.27…0.73 — clearly visible without looking like a hard
 * strobe — and at high frequency the mean tracks duty.
 */

/** Eye / display persistence time constant (seconds), rise and fall. */
export const LED_PERSISTENCE_TAU_S = 0.01

/** Instantaneous electrical drive: true = LED current on. */
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

/**
 * One exponential step toward on (1) or off (0).
 * Exact solution of dv/dt = (target − v) / τ over dtSec.
 */
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

/**
 * Advance perceived brightness over [t0Ns, t1Ns) by integrating exact PWM
 * segments (no per-frame aliasing of a 50 Hz wave against a 60 Hz display).
 */
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

/** Map perceived 0…1 to the same opacity floor the static duty map used. */
export function ledGlowOpacity(perceived: number): number {
  const v = Math.max(0, Math.min(1, perceived))
  if (v <= 0.02) return 0
  return 0.3 + 0.7 * v
}

export function ledIsLit(perceived: number): boolean {
  return perceived > 0.02
}
