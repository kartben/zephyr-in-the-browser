/**
 * DAC history ring — retention must hold a full stock sawtooth in the default
 * 10 s scope window (~1 sample/ms × 4096 codes ≈ 4 s).
 */

import { describe, expect, it } from 'vitest'
import {
  DAC_DEFAULT_WINDOW_MS,
  DAC_HISTORY_RETENTION_MS,
  createDacHistory,
  formatDacWindow,
} from './model'

describe('createDacHistory', () => {
  it('keeps a 4 s 1 kHz sawtooth inside the default 10 s window', () => {
    let t = 0
    const history = createDacHistory({
      channelCount: 1,
      retentionMs: DAC_HISTORY_RETENTION_MS,
      now: () => t,
    })
    const period = 4096
    for (let i = 0; i < period; i++) {
      t = i
      history.push(0, i, i / period)
    }
    t = period
    const samples = history.get(0)
    expect(samples.length).toBe(period)
    expect(samples[0]!.t).toBe(0)
    expect(samples[samples.length - 1]!.code).toBe(period - 1)
    // Still inside the default window measured back from "now".
    expect(t - samples[0]!.t).toBeLessThanOrEqual(DAC_DEFAULT_WINDOW_MS)
  })

  it('prunes by retention, not a 2048-point cap that ate the period', () => {
    let t = 0
    const history = createDacHistory({
      channelCount: 1,
      retentionMs: 10_000,
      now: () => t,
    })
    for (let i = 0; i < 6000; i++) {
      t = i
      history.push(0, i & 0xfff, 0)
    }
    t = 6000
    const samples = history.get(0)
    // 10 s retention from t=6000 keeps ~[0..6000] but capacity is fine.
    expect(samples.length).toBeGreaterThan(2048)
    expect(samples[0]!.t).toBeGreaterThanOrEqual(6000 - 10_000)
  })
})

describe('formatDacWindow', () => {
  it('formats whole seconds compactly', () => {
    expect(formatDacWindow(10_000)).toBe('10 s')
    expect(formatDacWindow(DAC_DEFAULT_WINDOW_MS)).toBe('10 s')
  })
})
