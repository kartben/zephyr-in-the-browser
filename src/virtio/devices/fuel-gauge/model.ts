/** Bus-agnostic fuel-gauge surface the dock renders. */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'

export interface FuelGaugeDecl {
  name: string
  vEmptyMv: number
  vFullMv: number
  designCapacityMah?: number
  detailKeys?: readonly string[]
}

export interface FuelGaugeReading {
  socPct: number
  voltageUv: number
  /** Positive = charging, negative = discharging; matches Zephyr CRATE. */
  cratePctPerHour: number
  charging: boolean
}

export interface FuelGaugeChip extends I2cChip {
  readonly decl: FuelGaugeDecl
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getReading(): FuelGaugeReading
  setSocPct(pct: number): void
  setVoltageMv(mv: number): void
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

export function voltageFraction(
  voltageUv: number,
  decl: Pick<FuelGaugeDecl, 'vEmptyMv' | 'vFullMv'>,
): number {
  const mv = voltageUv / 1000
  const span = decl.vFullMv - decl.vEmptyMv
  if (span <= 0) return 0
  return Math.max(0, Math.min(1, (mv - decl.vEmptyMv) / span))
}

/** Estimate time-to-empty/full from SoC and CRATE, matching Zephyr MAX17048. */
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
