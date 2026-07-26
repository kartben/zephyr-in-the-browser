import { describe, expect, it } from 'vitest'
import { fallbackDefs, makeEventDef } from './metadata'
import {
  TraceReader,
  laneOrder,
  threadLabel,
  renderStateRows,
  fmtTime,
  niceTimeStep,
  threadRunningAt,
  windowStats,
  contextSwitchesIn,
} from './reader'

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

/** Build one CTF record: timestamp + id + body. */
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

describe('TraceReader', () => {
  it('decodes a ping-pong of thread switches into run/ready segments', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    const bytes = [
      ...record(1000, 0x13, [...encU32(a), ...encName('thread_a')]),
      ...record(1100, 0x13, [...encU32(b), ...encName('thread_b')]),
      ...record(2000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(3000, 0x10, [...encU32(a), ...encName('thread_a')]),
      ...record(3000, 0x11, [...encU32(b), ...encName('thread_b')]),
      ...record(5000, 0x10, [...encU32(b), ...encName('thread_b')]),
      ...record(5000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(7000, 0x10, [...encU32(a), ...encName('thread_a')]),
    ]
    expect(reader.feed(Uint8Array.from(bytes))).toBe(8)
    expect(reader.tr.threads.size).toBe(2)
    expect(threadLabel(reader.tr, a)).toBe('thread_a')
    expect(threadLabel(reader.tr, b)).toBe('thread_b')
    expect(reader.tr.segments).toEqual([
      [2000, 3000, a],
      [3000, 5000, b],
      [5000, 7000, a],
    ])
    const order = laneOrder(reader.tr)
    expect(order[0]).toBe(a) // 3000 ns busy vs 2000
    const rows = renderStateRows(reader.tr, order, reader.tr.t0, reader.tr.t1, 10)
    expect(rows.get(a)?.some((c) => c === 'run')).toBe(true)
    expect(rows.get(b)?.some((c) => c === 'run')).toBe(true)
  })

  it('holds a partial trailing record until the rest arrives', () => {
    const reader = new TraceReader(fallbackDefs())
    const full = record(100, 0x1b, [])
    const first = full.subarray(0, 6)
    const rest = full.subarray(6)
    expect(reader.feed(first)).toBe(0)
    expect(reader.tr.events).toHaveLength(0)
    expect(reader.feed(rest)).toBe(1)
    expect(reader.tr.events[0]?.name).toBe('isr_enter')
  })

  it('flags desync on an unknown event id without consuming past it', () => {
    const reader = new TraceReader(fallbackDefs())
    const bad = record(1, 0xdead, [1, 2, 3, 4])
    expect(reader.feed(bad)).toBe(0)
    expect(reader.desync).toBe(true)
  })

  it('makeEventDef sizes a str20 + uint32 body at 24 bytes', () => {
    const def = makeEventDef(0x11, 'thread_switched_in', [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
    ])
    expect(def.size).toBe(24)
  })
})

describe('time-axis helpers', () => {
  it('fmtTime picks ns / µs / ms / s like the Python viewer', () => {
    expect(fmtTime(500)).toBe('500ns')
    expect(fmtTime(1_500)).toBe('1.500µs')
    expect(fmtTime(2_500_000)).toBe('2.500ms')
    expect(fmtTime(1_250_000_000)).toBe('1.250s')
  })

  it('niceTimeStep lands on a 1/2/5×10^n ladder', () => {
    expect(niceTimeStep(1_000_000_000, 5)).toBe(200_000_000)
    expect(niceTimeStep(5_000_000, 5)).toBe(1_000_000)
  })

  it('windowStats and threadRunningAt match the visible window', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    const bytes = [
      ...record(0, 0x13, [...encU32(a), ...encName('thread_a')]),
      ...record(0, 0x13, [...encU32(b), ...encName('thread_b')]),
      ...record(1_000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(5_000, 0x10, [...encU32(a), ...encName('thread_a')]),
      ...record(5_000, 0x11, [...encU32(b), ...encName('thread_b')]),
      ...record(9_000, 0x10, [...encU32(b), ...encName('thread_b')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(threadRunningAt(reader.tr, 3_000)).toBe(a)
    expect(threadRunningAt(reader.tr, 7_000)).toBe(b)
    const { per, spanNs } = windowStats(reader.tr, 0, 10_000)
    expect(spanNs).toBe(10_000)
    expect(per.get(a)?.run).toBe(4_000)
    expect(per.get(b)?.run).toBe(4_000)
    expect(contextSwitchesIn(reader.tr, 0, 10_000)).toBe(2)
    // Window that starts mid-trace must still skip the early SWITCHED_IN at t=1k.
    expect(contextSwitchesIn(reader.tr, 4_000, 10_000)).toBe(1)
    expect(contextSwitchesIn(reader.tr, 6_000, 10_000)).toBe(0)
  })
})
