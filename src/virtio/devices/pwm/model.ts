/** Bus-agnostic PWM surface the dock renders. */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'

export interface PwmDecl {
  name: string
  channelCount: number
  /**
   * `controller` = one period for all channels; `per-channel` = each channel
   * owns its period. The chart reads the selected channel either way.
   */
  periodScope: 'controller' | 'per-channel'
  detailKeys?: readonly string[]
}

export interface PwmChannel {
  index: number
  duty: number
  periodNs: number
  pulseNs: number
  fullOn: boolean
  fullOff: boolean
  inverted: boolean
}

export interface PwmChip extends I2cChip {
  readonly decl: PwmDecl
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getChannel(index: number): PwmChannel
  getDetail?(key: string): string
  version(): number
  subscribe(fn: () => void): () => void
}

export function isPwmChip(chip: I2cChip | null | undefined): chip is PwmChip {
  const candidate = chip as PwmChip | null | undefined
  return (
    !!candidate &&
    typeof candidate.decl === 'object' &&
    candidate.decl != null &&
    typeof candidate.decl.channelCount === 'number' &&
    (candidate.decl.periodScope === 'controller' ||
      candidate.decl.periodScope === 'per-channel') &&
    typeof candidate.getChannel === 'function' &&
    typeof candidate.version === 'function' &&
    typeof candidate.subscribe === 'function' &&
    Array.isArray(candidate.registers)
  )
}

export function formatPwmDuration(ns: number): string {
  if (!Number.isFinite(ns) || ns < 0) return '—'
  if (ns >= 1e6) {
    const ms = ns / 1e6
    return `${ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)} ms`
  }
  if (ns >= 1e3) {
    const us = ns / 1e3
    return `${us >= 10 ? us.toFixed(1) : us.toFixed(2)} µs`
  }
  return `${Math.round(ns)} ns`
}

export function formatPwmFrequency(periodNs: number): string {
  if (!Number.isFinite(periodNs) || periodNs <= 0) return '—'
  const hz = 1e9 / periodNs
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz`
  if (hz >= 100) return `${hz.toFixed(0)} Hz`
  if (hz >= 10) return `${hz.toFixed(1)} Hz`
  return `${hz.toFixed(2)} Hz`
}

export function formatPwmDuty(duty: number): string {
  if (!Number.isFinite(duty)) return '—'
  const pct = Math.max(0, Math.min(1, duty)) * 100
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`
}
