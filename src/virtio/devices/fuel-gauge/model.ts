/**
 * Bus-agnostic fuel-gauge surface the dock renders.
 *
 * A fuel gauge is state-of-charge + voltage (+ charge rate) — not a sensor
 * slider row and not a DAC scope. The first provider is an I²C MAX17048, but
 * {@link FuelGaugeChip} deliberately does not mention it: a later SBS gauge or
 * charger sibling can implement the same handle and reuse {@link FuelGaugeBody}
 * unchanged. When a provider has a register file it also implements
 * {@link RegisterMapSource}.
 */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'

export interface FuelGaugeDecl {
  name: string
  /** Empty-cell voltage for the gauge bar (mV). MAX17048 Li-ion: ~3000. */
  vEmptyMv: number
  /** Full-cell voltage for the gauge bar (mV). MAX17048 Li-ion: ~4200. */
  vFullMv: number
  /** Optional design capacity shown in the metrics strip. */
  designCapacityMah?: number
  /** Optional metrics strip keys (MAX17048: crate, tte, ttf). */
  detailKeys?: readonly string[]
}

export interface FuelGaugeReading {
  /** Relative state of charge, 0…100. */
  socPct: number
  /** Cell voltage in microvolts. */
  voltageUv: number
  /**
   * Charge rate in percent of capacity per hour. Positive = charging,
   * negative = discharging — matches Zephyr's CRATE interpretation.
   */
  cratePctPerHour: number
  charging: boolean
}

/**
 * What every fuel-gauge provider must expose to the dock. Extends
 * {@link I2cChip} only because today's providers ride virtio-i2c — the
 * fuel-gauge-shaped methods are what {@link isFuelGaugeChip} and the card care
 * about.
 */
export interface FuelGaugeChip extends I2cChip {
  readonly decl: FuelGaugeDecl
  /** Named register file for the inspector; empty when the provider has none. */
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getReading(): FuelGaugeReading
  /** Drive SoC from the page (writes SOC register). */
  setSocPct(pct: number): void
  /** Drive cell voltage from the page (writes VCELL register), millivolts. */
  setVoltageMv(mv: number): void
  /** Drive charge rate from the page (writes CRATE register), %/hour. */
  setCratePctPerHour(rate: number): void
  getDetail?(key: string): string
  version(): number
  subscribe(fn: () => void): () => void
}

export function isFuelGaugeChip(chip: I2cChip | null | undefined): chip is FuelGaugeChip {
  const candidate = chip as FuelGaugeChip | null | undefined
  return (
    !!candidate &&
    typeof candidate.decl === 'object' &&
    candidate.decl != null &&
    typeof candidate.decl.vEmptyMv === 'number' &&
    typeof candidate.decl.vFullMv === 'number' &&
    typeof candidate.getReading === 'function' &&
    typeof candidate.setSocPct === 'function' &&
    typeof candidate.setVoltageMv === 'function' &&
    typeof candidate.setCratePctPerHour === 'function' &&
    typeof candidate.version === 'function' &&
    typeof candidate.subscribe === 'function' &&
    Array.isArray(candidate.registers)
  )
}

export function formatSocPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${Math.round(Math.max(0, Math.min(100, pct)))}%`
}

export function formatVoltageMv(uv: number): string {
  if (!Number.isFinite(uv)) return '—'
  const mv = uv / 1000
  if (Math.abs(mv) >= 1000) return `${(mv / 1000).toFixed(2)} V`
  return `${mv.toFixed(0)} mV`
}

export function formatCrate(pctPerHour: number): string {
  if (!Number.isFinite(pctPerHour)) return '—'
  const sign = pctPerHour > 0 ? '+' : ''
  return `${sign}${pctPerHour.toFixed(1)} %/h`
}

export function formatRuntimeMins(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—'
  if (mins < 60) return `${Math.round(mins)} min`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m === 0 ? `${h} h` : `${h} h ${m} m`
}

/** Fraction 0…1 of the voltage bar between empty and full. */
export function voltageFraction(
  voltageUv: number,
  decl: Pick<FuelGaugeDecl, 'vEmptyMv' | 'vFullMv'>,
): number {
  const mv = voltageUv / 1000
  const span = decl.vFullMv - decl.vEmptyMv
  if (span <= 0) return 0
  return Math.max(0, Math.min(1, (mv - decl.vEmptyMv) / span))
}

/**
 * Estimate time-to-empty / time-to-full the way Zephyr's MAX17048 driver does
 * from SoC and CRATE — exposed for the dock metrics strip.
 */
export function estimateRuntimeMins(reading: FuelGaugeReading): {
  toEmpty: number
  toFull: number
} {
  const rate = reading.cratePctPerHour
  if (rate === 0) return { toEmpty: 0, toFull: 0 }
  if (rate > 0) {
    const pending = 100 - reading.socPct
    return { toEmpty: 0, toFull: (pending / rate) * 60 }
  }
  return { toEmpty: (reading.socPct / -rate) * 60, toFull: 0 }
}
