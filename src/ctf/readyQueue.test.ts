import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader } from './reader'
import {
  compareReadyOrder,
  isHigherPriority,
  latestPriorityPreemption,
  priorityPreemptionsIn,
  readyQueueAt,
} from './readyQueue'

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
function encI8(n: number): number[] {
  return [n & 0xff]
}
function encName(s: string): number[] {
  const out = Array.from({ length: 20 }, () => 0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

/** low (prio 7) runs, then high (prio 1) steals the CPU. */
function preemptionTrace() {
  const reader = new TraceReader(fallbackDefs())
  const low = 0x1000
  const high = 0x2000
  const bytes = [
    ...record(100, 0x13, [...encU32(low), ...encName('low')]),
    ...record(110, 0x13, [...encU32(high), ...encName('high')]),
    ...record(200, 0x12, [...encU32(low), ...encName('low'), ...encI8(7)]),
    ...record(210, 0x12, [...encU32(high), ...encName('high'), ...encI8(1)]),
    ...record(1000, 0x11, [...encU32(low), ...encName('low')]),
    // high becomes ready while low is running, then steals.
    ...record(2000, 0x17, [...encU32(high), ...encName('high')]),
    ...record(2100, 0x10, [...encU32(low), ...encName('low')]),
    ...record(2100, 0x11, [...encU32(high), ...encName('high')]),
    ...record(4000, 0x10, [...encU32(high), ...encName('high')]),
  ]
  reader.feed(Uint8Array.from(bytes))
  return { reader, low, high }
}

describe('readyQueue', () => {
  it('compareReadyOrder puts lower prio numbers first; unknown last', () => {
    expect(compareReadyOrder({ tid: 2, prio: 1 }, { tid: 1, prio: 7 })).toBeLessThan(0)
    expect(compareReadyOrder({ tid: 1, prio: null }, { tid: 2, prio: 5 })).toBeGreaterThan(0)
    expect(compareReadyOrder({ tid: 1, prio: 3 }, { tid: 2, prio: 3 })).toBeLessThan(0)
  })

  it('isHigherPriority requires both known and a stricter (lower) number', () => {
    expect(isHigherPriority(1, 7)).toBe(true)
    expect(isHigherPriority(7, 1)).toBe(false)
    expect(isHigherPriority(1, 1)).toBe(false)
    expect(isHigherPriority(null, 7)).toBe(false)
    expect(isHigherPriority(1, null)).toBe(false)
  })

  it('readyQueueAt lists run+ready threads highest-priority first', () => {
    const { reader, low, high } = preemptionTrace()
    // Just after high becomes ready, both are on the queue; low still runs.
    const mid = readyQueueAt(reader.tr, 2050)
    expect(mid.rungs.map((r) => r.tid)).toEqual([high, low])
    expect(mid.rungs[0]!.state).toBe('rdy')
    expect(mid.rungs[1]!.state).toBe('run')
    expect(mid.runner).toBe(low)
    expect(mid.isr).toBe(false)

    const after = readyQueueAt(reader.tr, 3000)
    // Preempted `low` stays ready (it did not block/sleep) — both remain on the queue.
    expect(after.rungs.map((r) => r.tid)).toEqual([high, low])
    expect(after.rungs[0]!.state).toBe('run')
    expect(after.rungs[1]!.state).toBe('rdy')
    expect(after.runner).toBe(high)
  })

  it('priorityPreemptionsIn records only higher-priority steals', () => {
    const { reader, low, high } = preemptionTrace()
    const hits = priorityPreemptionsIn(reader.tr, 0, 5000)
    expect(hits).toEqual([
      {
        ts: 2100,
        fromTid: low,
        toTid: high,
        fromPrio: 7,
        toPrio: 1,
      },
    ])
    expect(latestPriorityPreemption(reader.tr, 0, 5000, 3000)?.ts).toBe(2100)
    expect(latestPriorityPreemption(reader.tr, 0, 5000, 2000)).toBeNull()
  })

  it('ignores equal-priority handoffs', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    const bytes = [
      ...record(100, 0x13, [...encU32(a), ...encName('a')]),
      ...record(110, 0x13, [...encU32(b), ...encName('b')]),
      ...record(200, 0x12, [...encU32(a), ...encName('a'), ...encI8(5)]),
      ...record(210, 0x12, [...encU32(b), ...encName('b'), ...encI8(5)]),
      ...record(1000, 0x11, [...encU32(a), ...encName('a')]),
      ...record(2000, 0x10, [...encU32(a), ...encName('a')]),
      ...record(2000, 0x11, [...encU32(b), ...encName('b')]),
      ...record(3000, 0x10, [...encU32(b), ...encName('b')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(priorityPreemptionsIn(reader.tr, 0, 4000)).toEqual([])
  })
})
