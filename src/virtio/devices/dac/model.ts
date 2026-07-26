/** Bus-agnostic DAC surface the dock renders; providers may expose register maps. */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import { dacNowMs } from './clock'

export const DAC_WINDOW_MS_OPTIONS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

export const DAC_DEFAULT_WINDOW_MS = 10_000

export const DAC_HISTORY_RETENTION_MS = 30_000

export interface DacDecl {
  name: string
  channelCount: number
  resolutionBits: number
  vrefMv: number
  detailKeys?: readonly string[]
}

export interface DacChannel {
  index: number
  code: number
  volts: number
  powerDown: 'normal' | '1k' | '100k' | '500k' | string
}

export interface DacSample {
  t: number
  channel: number
  volts: number
  code: number
}

export interface DacChip extends I2cChip {
  readonly decl: DacDecl
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  getChannel(index: number): DacChannel
  /**
   * Zero-copy chronological view of the Vout ring. Prefer walking
   * {@link DacHistoryView.at} over materialising an array — the stock DAC
   * sample writes at 1 kHz.
   */
  getHistory(channel: number): DacHistoryView
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
  // Full-scale code maps to Vref, so the divisor is (2^bits - 1), not 2^bits.
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

/** Chronological ring view; hot paths should walk it without materialising. */
export interface DacHistoryView {
  readonly length: number
  at(index: number): DacSample
  /**
   * First chronological index whose `t >= t0`, or `length` if all are older.
   * Callers that hold a step often want `max(0, index - 1)`.
   */
  lowerBound(t0: number): number
}

/**
 * Per-channel Vout history. Capacity assumes ~1 sample/ms; push/prune stay O(1)
 * per dropped sample, with no `shift`/`splice` on the 1 kHz I²C path.
 */
export function createDacHistory(opts: {
  channelCount: number
  retentionMs?: number
  now?: () => number
}): {
  push(channel: number, code: number, volts: number, t?: number): void
  view(channel: number): DacHistoryView
  get(channel: number): readonly DacSample[]
} {
  const retentionMs = opts.retentionMs ?? DAC_HISTORY_RETENTION_MS
  // 1 kHz guest writes × retention, plus headroom for bursts.
  const capacity = Math.max(4096, Math.ceil(retentionMs * 1.25))
  const nowFn = opts.now ?? dacNowMs

  interface Ring {
    buf: (DacSample | undefined)[]
    head: number
    length: number
    snapshot: DacSample[] | null
  }

  const rings: Ring[] = Array.from({ length: opts.channelCount }, () => ({
    buf: new Array(capacity),
    head: 0,
    length: 0,
    snapshot: null,
  }))

  const at = (ring: Ring, index: number): DacSample => {
    const s = ring.buf[(ring.head + index) % capacity]
    if (!s) throw new Error('dac history: empty slot')
    return s
  }

  const dropOldest = (ring: Ring) => {
    ring.head = (ring.head + 1) % capacity
    ring.length--
    ring.snapshot = null
  }

  const prune = (ring: Ring, now: number) => {
    const cutoff = now - retentionMs
    while (ring.length > 0 && at(ring, 0).t < cutoff) dropOldest(ring)
    while (ring.length > capacity) dropOldest(ring)
  }

  const lowerBound = (ring: Ring, t0: number): number => {
    let lo = 0
    let hi = ring.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (at(ring, mid).t < t0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const makeView = (ring: Ring): DacHistoryView => ({
    get length() {
      return ring.length
    },
    at: (index) => at(ring, index),
    lowerBound: (t0) => lowerBound(ring, t0),
  })

  return {
    push(channel, code, volts, t = nowFn()) {
      if (channel < 0 || channel >= rings.length) return
      const ring = rings[channel]!
      const last = ring.length > 0 ? at(ring, ring.length - 1) : undefined
      // Coalesce sub-millisecond repeats of the same code.
      if (last && last.code === code && t - last.t < 1) {
        last.t = t
        last.volts = volts
        prune(ring, t)
        return
      }
      const sample: DacSample = { t, channel, volts, code }
      if (ring.length < capacity) {
        ring.buf[(ring.head + ring.length) % capacity] = sample
        ring.length++
      } else {
        ring.buf[ring.head] = sample
        ring.head = (ring.head + 1) % capacity
      }
      ring.snapshot = null
      prune(ring, t)
    },
    view(channel) {
      if (channel < 0 || channel >= rings.length) {
        return { length: 0, at: () => {
          throw new Error('dac history: empty')
        }, lowerBound: () => 0 }
      }
      const ring = rings[channel]!
      prune(ring, nowFn())
      return makeView(ring)
    },
    get(channel) {
      if (channel < 0 || channel >= rings.length) return []
      const ring = rings[channel]!
      prune(ring, nowFn())
      if (ring.snapshot) return ring.snapshot
      const out: DacSample[] = new Array(ring.length)
      for (let i = 0; i < ring.length; i++) out[i] = at(ring, i)
      ring.snapshot = out
      return out
    },
  }
}
