/**
 * DAC history ring — retention must hold a full stock sawtooth in the default
 * 10 s scope window (~1 sample/ms × 4096 codes ≈ 4 s).
 *
 * Push must stay O(1) amortized: the stock sample hits this from virtio-i2c at
 * 1 kHz, and an array+shift ring made the Vout chart lag the guest.
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

  it('exposes a zero-copy view with lowerBound for the scope', () => {
    let t = 0
    const history = createDacHistory({
      channelCount: 1,
      retentionMs: 10_000,
      now: () => t,
    })
    for (let i = 0; i < 100; i++) {
      t = i * 10
      history.push(0, i, 0)
    }
    const view = history.view(0)
    expect(view.length).toBe(100)
    expect(view.at(0).t).toBe(0)
    expect(view.at(99).code).toBe(99)
    expect(view.lowerBound(500)).toBe(50)
    expect(view.lowerBound(0)).toBe(0)
    expect(view.lowerBound(10_000)).toBe(100)
  })

  it('survives a 30 s 1 kHz fill without quadratic shift cost', () => {
    let t = 0
    const history = createDacHistory({
      channelCount: 1,
      retentionMs: DAC_HISTORY_RETENTION_MS,
      now: () => t,
    })
    const n = 30_000
    const started = performance.now()
    for (let i = 0; i < n; i++) {
      t = i
      history.push(0, i & 0xfff, 0)
    }
    const elapsed = performance.now() - started
    expect(history.view(0).length).toBeGreaterThan(20_000)
    // A shift()-based ring was multi-second here; O(1) stays well under 500 ms
    // even on a cold CI box.
    expect(elapsed).toBeLessThan(500)
  })
})

describe('formatDacWindow', () => {
  it('formats whole seconds compactly', () => {
    expect(formatDacWindow(10_000)).toBe('10 s')
    expect(formatDacWindow(DAC_DEFAULT_WINDOW_MS)).toBe('10 s')
  })
})
