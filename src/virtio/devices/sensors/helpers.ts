/**
 * Shared encoding helpers for declarative I²C sensors.
 *
 * Keep chip files to register maps and sensitivity math; clamp/mask lives here
 * so ADXL / LSM6DSO / LPS22HH / INA219 / ISL29035 stay consistent.
 */

/** Clamp to a signed `bits`-wide field, then return as an unsigned word. */
export function clampToUint(counts: number, bits: 8 | 16 | 24 = 16): number {
  const max = (1 << (bits - 1)) - 1
  const min = -(1 << (bits - 1))
  const clamped = Math.min(max, Math.max(min, Math.round(counts)))
  return clamped & (bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffff)
}

/** Clamp to an unsigned `bits`-wide field. */
export function clampUint(counts: number, bits: 8 | 16 | 24 = 16): number {
  const max = (1 << bits) - 1
  return Math.min(max, Math.max(0, Math.round(counts))) & max
}
