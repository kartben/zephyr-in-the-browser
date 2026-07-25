/**
 * Bus-agnostic DAC surface the dock renders.
 *
 * A DAC is coded channels with a voltage output — not PWM duty and not a
 * sensor slider. The first provider is an I²C MCP4725, but {@link DacChip}
 * deliberately does not mention it: a multi-channel part or SoC DAC can
 * implement the same handle and reuse {@link DacBody} unchanged. When a
 * provider has inspector shadows it also implements {@link RegisterMapSource}.
 */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import { dacNowMs } from './clock'

/** Scope window choices (ms). Default {@link DAC_DEFAULT_WINDOW_MS}. */
export const DAC_WINDOW_MS_OPTIONS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export const DAC_DEFAULT_WINDOW_MS = 10_000

/** How long providers retain samples — covers the largest scope window. */
export const DAC_HISTORY_RETENTION_MS = 30_000

export interface DacDecl {
  name: string
  /** Output channels (MCP4725: 1; MCP4728: 4). */
  channelCount: number
  /** Bits of code the guest writes (MCP4725: 12). */
  resolutionBits: number
  /**
   * Full-scale reference in millivolts. MCP4725 is VDD-referenced; default
   * 3300 for the page.
   */
  vrefMv: number
  /** Optional metrics strip keys (MCP4725: mode, eeprom). */
  detailKeys?: readonly string[]
}

export interface DacChannel {
  index: number
  /** Raw code 0 .. (1<<resolutionBits)-1 */
  code: number
  /** Engineering volts = code / maxCode * (vrefMv/1000). */
  volts: number
  /** Power-down / load mode when the part has one. */
  powerDown: 'normal' | '1k' | '100k' | '500k' | string
}

export interface DacSample {
  /** {@link dacNowMs} when the code changed (guest virtual time when available). */
  t: number
  channel: number
  volts: number
  code: number
}

/**
 * What every DAC provider must expose to the dock. Extends {@link I2cChip} only
 * because today's providers ride virtio-i2c — the DAC-shaped methods are what
 * {@link isDacChip} and the card care about.
 */
export interface DacChip extends I2cChip {
  readonly decl: DacDecl
  /** Named register file for the inspector; empty when the provider has none. */
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getChannel(index: number): DacChannel
  getHistory(channel: number): readonly DacSample[]
  getDetail?(key: string): string
  version(): number
  subscribe(fn: () => void): () => void
}

export function isDacChip(chip: I2cChip | null | undefined): chip is DacChip {
  const candidate = chip as DacChip | null | undefined
  return (
    !!candidate &&
    typeof candidate.decl === 'object' &&
    candidate.decl != null &&
    typeof candidate.decl.channelCount === 'number' &&
    typeof candidate.decl.resolutionBits === 'number' &&
    typeof candidate.decl.vrefMv === 'number' &&
    typeof candidate.getChannel === 'function' &&
    typeof candidate.getHistory === 'function' &&
    typeof candidate.version === 'function' &&
    typeof candidate.subscribe === 'function' &&
    Array.isArray(candidate.registers)
  )
}

export function dacMaxCode(decl: Pick<DacDecl, 'resolutionBits'>): number {
  return (1 << decl.resolutionBits) - 1
}

export function dacCodeToVolts(code: number, decl: Pick<DacDecl, 'resolutionBits' | 'vrefMv'>): number {
  const max = dacMaxCode(decl)
  if (max <= 0) return 0
  const clamped = Math.max(0, Math.min(max, code))
  return (clamped / max) * (decl.vrefMv / 1000)
}

export function formatDacVolts(volts: number): string {
  if (!Number.isFinite(volts)) return '—'
  if (Math.abs(volts) >= 10) return `${volts.toFixed(1)} V`
  return `${volts.toFixed(2)} V`
}

export function formatDacCode(code: number, resolutionBits: number): string {
  const max = (1 << resolutionBits) - 1
  return `${code} / ${max}`
}

export function formatDacWindow(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} s`
  return `${ms} ms`
}

/**
 * Per-channel ring of output samples for the Vout chart. Providers call
 * {@link DacHistory.push} whenever a channel's code changes.
 *
 * Retention is long enough for the largest scope window; the panel picks the
 * visible slice. Capacity assumes ~1 sample/ms (stock `samples/drivers/dac`).
 */
export function createDacHistory(opts: {
  channelCount: number
  retentionMs?: number
  /** Override clock (tests). Defaults to {@link dacNowMs}. */
  now?: () => number
}): {
  push(channel: number, code: number, volts: number, t?: number): void
  get(channel: number): readonly DacSample[]
} {
  const retentionMs = opts.retentionMs ?? DAC_HISTORY_RETENTION_MS
  // 1 kHz guest writes × retention, plus headroom for bursts.
  const maxPoints = Math.max(4096, Math.ceil(retentionMs * 1.25))
  const nowFn = opts.now ?? dacNowMs
  const rings: DacSample[][] = Array.from({ length: opts.channelCount }, () => [])

  const prune = (channel: number, now: number) => {
    const ring = rings[channel]
    if (!ring) return
    const cutoff = now - retentionMs
    while (ring.length > 0 && ring[0]!.t < cutoff) ring.shift()
    if (ring.length > maxPoints) ring.splice(0, ring.length - maxPoints)
  }

  return {
    push(channel, code, volts, t = nowFn()) {
      if (channel < 0 || channel >= rings.length) return
      const ring = rings[channel]!
      const last = ring[ring.length - 1]
      // Coalesce sub-millisecond repeats of the same code.
      if (last && last.code === code && t - last.t < 1) {
        last.t = t
        last.volts = volts
        prune(channel, t)
        return
      }
      ring.push({ t, channel, volts, code })
      prune(channel, t)
    },
    get(channel) {
      if (channel < 0 || channel >= rings.length) return []
      prune(channel, nowFn())
      return rings[channel]!
    },
  }
}
