/** Shared encoding helpers for declarative I2C sensors. */

export function clampToUint(counts: number, bits: 8 | 16 | 24 = 16): number {
  const max = (1 << (bits - 1)) - 1
  const min = -(1 << (bits - 1))
  const clamped = Math.min(max, Math.max(min, Math.round(counts)))
  return clamped & (bits === 8 ? 0xff : bits === 16 ? 0xffff : 0xffffff)
}

export function clampUint(counts: number, bits: 8 | 16 | 24 = 16): number {
  const max = (1 << bits) - 1
  return Math.min(max, Math.max(0, Math.round(counts))) & max
}
