import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import {
  dutyBuckets,
  formatPct,
  formatResidencyDuration,
  idleThreadIds,
  reconstructCpuResidency,
  residencyWindowStats,
} from './powerResidency'
import { TraceReader } from './reader'

function encU16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function encU64(n: number): number[] {
  const out = Array.from({ length: 8 }, () => 0)
  let x = n
  for (let i = 0; i < 8; i++) {
    out[i] = x & 0xff
    x = Math.floor(x / 256)
  }
  return out
}
function encName(s: string): number[] {
  const out = Array.from({ length: 20 }, () => 0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

describe('reconstructCpuResidency', () => {
  it('classifies idle vs worker run spans and coalesces adjacent idle', () => {
    const idle = 0x1000
    const worker = 0x2000
    const reader = new TraceReader(fallbackDefs())
    const bytes = [
      ...record(100, 0x13, [...encU32(idle), ...encName('idle')]),
      ...record(100, 0x13, [...encU32(worker), ...encName('blinky')]),
      ...record(1000, 0x11, [...encU32(idle), ...encName('idle')]),
      ...record(3000, 0x10, [...encU32(idle), ...encName('idle')]),
      ...record(3000, 0x11, [...encU32(worker), ...encName('blinky')]),
      ...record(3500, 0x10, [...encU32(worker), ...encName('blinky')]),
      ...record(3500, 0x11, [...encU32(idle), ...encName('idle')]),
      ...record(8000, 0x10, [...encU32(idle), ...encName('idle')]),
    ]
    expect(reader.feed(Uint8Array.from(bytes))).toBeGreaterThan(0)

    const ids = idleThreadIds(reader.tr)
    expect(ids.has(idle)).toBe(true)
    expect(ids.has(worker)).toBe(false)

    const res = reconstructCpuResidency(reader.tr)
    expect(res.hasIdleThread).toBe(true)
    expect(res.segments).toEqual([
      { start: 1000, end: 3000, mode: 'idle' },
      { start: 3000, end: 3500, mode: 'active' },
      { start: 3500, end: 8000, mode: 'idle' },
    ])
    expect(res.wakes).toEqual([{ ts: 3000, reason: 'thread' }])
  })

  it('marks ISR starts that fall inside an idle bout as wakes', () => {
    const idle = 0x1000
    const reader = new TraceReader(fallbackDefs())
    const bytes = [
      ...record(50, 0x13, [...encU32(idle), ...encName('idle')]),
      ...record(1000, 0x11, [...encU32(idle), ...encName('idle')]),
      ...record(2000, 0x1b, []),
      ...record(2100, 0x1c, []),
      ...record(5000, 0x10, [...encU32(idle), ...encName('idle')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    const res = reconstructCpuResidency(reader.tr)
    expect(res.segments).toEqual([{ start: 1000, end: 5000, mode: 'idle' }])
    expect(res.wakes).toEqual([{ ts: 2000, reason: 'isr' }])
  })

  it('treats everything as active when no idle thread is named', () => {
    const a = 0x1000
    const reader = new TraceReader(fallbackDefs())
    const bytes = [
      ...record(100, 0x13, [...encU32(a), ...encName('main')]),
      ...record(1000, 0x11, [...encU32(a), ...encName('main')]),
      ...record(4000, 0x10, [...encU32(a), ...encName('main')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    const res = reconstructCpuResidency(reader.tr)
    expect(res.hasIdleThread).toBe(false)
    expect(res.segments).toEqual([{ start: 1000, end: 4000, mode: 'active' }])
    expect(res.wakes).toEqual([])
  })
})

describe('residencyWindowStats / dutyBuckets', () => {
  const res = {
    hasIdleThread: true,
    segments: [
      { start: 0, end: 800, mode: 'idle' as const },
      { start: 800, end: 1000, mode: 'active' as const },
      { start: 1000, end: 2000, mode: 'idle' as const },
    ],
    wakes: [
      { ts: 800, reason: 'thread' as const },
      { ts: 1500, reason: 'isr' as const },
    ],
  }

  it('computes busy/idle percentages and mean idle bout', () => {
    const stats = residencyWindowStats(res, 0, 2000)
    expect(stats.spanNs).toBe(2000)
    expect(stats.activeNs).toBe(200)
    expect(stats.idleNs).toBe(1800)
    expect(stats.busyPct).toBeCloseTo(0.1)
    expect(stats.idlePct).toBeCloseTo(0.9)
    expect(stats.wakeCount).toBe(2)
    expect(stats.idleBouts).toBe(2)
    expect(stats.meanIdleNs).toBe(900)
  })

  it('clips to the visible window', () => {
    const stats = residencyWindowStats(res, 900, 1100)
    expect(stats.activeNs).toBe(100)
    expect(stats.idleNs).toBe(100)
    expect(stats.wakeCount).toBe(0)
  })

  it('fills duty buckets with busy fraction', () => {
    const buckets = dutyBuckets(res, 0, 2000, 4)
    expect(buckets).toHaveLength(4)
    // 0–500 idle, 500–1000 half idle / 200 active, 1000–2000 idle
    expect(buckets[0]).toBeCloseTo(0)
    expect(buckets[1]).toBeCloseTo(0.4)
    expect(buckets[2]).toBeCloseTo(0)
    expect(buckets[3]).toBeCloseTo(0)
  })
})

describe('format helpers', () => {
  it('formats durations and percents', () => {
    expect(formatResidencyDuration(500)).toBe('500 ns')
    expect(formatResidencyDuration(2500)).toBe('2.5 µs')
    expect(formatResidencyDuration(12_400_000)).toMatch(/ms/)
    expect(formatPct(0.182)).toBe('18%')
    expect(formatPct(0.082)).toBe('8.2%')
  })
})
