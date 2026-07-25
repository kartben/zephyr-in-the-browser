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
  /**
   * How much output history the chart keeps (ms of wall time). Default
   * ~5000 so one sawtooth period of the stock sample fits.
   */
  historyMs?: number
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
  /** performance.now() (or chip-local ms) when the code changed. */
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

/**
 * Per-channel ring of output samples for the Vout chart. Providers call
 * {@link DacHistory.push} whenever a channel's code changes.
 */
export function createDacHistory(opts: {
  channelCount: number
  historyMs?: number
}): {
  push(channel: number, code: number, volts: number, t?: number): void
  get(channel: number): readonly DacSample[]
} {
  const historyMs = opts.historyMs ?? 5000
  const rings: DacSample[][] = Array.from({ length: opts.channelCount }, () => [])

  const prune = (channel: number, now: number) => {
    const ring = rings[channel]
    if (!ring) return
    const cutoff = now - historyMs
    while (ring.length > 0 && ring[0]!.t < cutoff) ring.shift()
    // Cap absolute size so a bursty guest cannot grow without bound.
    const maxPoints = 2048
    if (ring.length > maxPoints) ring.splice(0, ring.length - maxPoints)
  }

  return {
    push(channel, code, volts, t = performance.now()) {
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
      prune(channel, performance.now())
      return rings[channel]!
    },
  }
}
