/**
 * Bus-agnostic PWM surface the dock renders.
 *
 * A PWM controller is channels with period + duty — not LEDs-as-bits and not a
 * hex dump. The first provider is an I²C PCA9685, but {@link PwmChip}
 * deliberately does not mention PCA9685: another I²C part, `pwm-gpio`, or an
 * SoC timer can implement the same handle and reuse {@link PwmBody} unchanged.
 * When a provider has a pointered register file it also implements
 * {@link RegisterMapSource} so the shared Registers inspector can open.
 */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'

export interface PwmDecl {
  name: string
  /** Channels this controller exposes (PCA9685: 16; a tiny part might be 1–4). */
  channelCount: number
  /**
   * How period is shared. `controller` = one period for every channel
   * (PCA9685 PRE_SCALE). `per-channel` = each channel can have its own T.
   * The chart always reads period from the *selected* channel either way.
   */
  periodScope: 'controller' | 'per-channel'
  /**
   * Optional extra metric keys under the strip. Providers with nothing
   * interesting leave this empty — the chart still works.
   */
  detailKeys?: readonly string[]
}

/** Decoded view of one output — what the duty-cycle chart needs. */
export interface PwmChannel {
  /** 0 .. decl.channelCount-1 */
  index: number
  /** Duty 0..1; full-on → 1, full-off → 0. */
  duty: number
  /** Period of this channel's output, nanoseconds. */
  periodNs: number
  /** High time, nanoseconds (0 .. periodNs). */
  pulseNs: number
  /** Sticky extremes (PCA9685 full-on/off bits; others may always be false). */
  fullOn: boolean
  fullOff: boolean
  /** Electrical polarity the guest last requested, if known. */
  inverted: boolean
}

/**
 * What every PWM provider must expose to the dock. Extends {@link I2cChip} only
 * because today's providers ride virtio-i2c — the PWM-shaped methods are what
 * {@link isPwmChip} and the card care about.
 */
export interface PwmChip extends I2cChip {
  readonly decl: PwmDecl
  /** Named register file for the inspector; empty when the provider has none. */
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getChannel(index: number): PwmChannel
  /** Optional controller-level details for the metrics strip. */
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

/** Format a nanosecond duration for the chart annotations. */
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

/** Frequency label from a period in nanoseconds. */
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
