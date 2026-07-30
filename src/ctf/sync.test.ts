import { describe, expect, it } from 'vitest'
import { makeEventDef } from './metadata'
import {
  nearestSyncMark,
  reconstructSync,
  syncCountAt,
  syncLabel,
  syncWindowStats,
} from './sync'
import { TraceReader } from './reader'

function encU16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function encI32(n: number): number[] {
  return encU32(n >>> 0)
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
function encStr(s: string, width: number): number[] {
  const out = Array.from({ length: width }, () => 0)
  for (let i = 0; i < Math.min(width, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

/** Minimal scheduling + sync defs for unit tests (ids match Zephyr TSDL). */
function syncDefs() {
  const defs = [
    makeEventDef(0x10, 'thread_switched_out', [['thread_id', 'uint32_t']]),
    makeEventDef(0x11, 'thread_switched_in', [['thread_id', 'uint32_t']]),
    makeEventDef(0x12, 'thread_prio_set', [
      ['thread_id', 'uint32_t'],
      ['prio', 'int8_t'],
    ]),
    makeEventDef(0x1a, 'thread_name_set', [
      ['thread_id', 'uint32_t'],
      ['name', { str: 20 }],
    ]),
    makeEventDef(0x21, 'semaphore_init', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x23, 'semaphore_give_exit', [['id', 'uint32_t']]),
    makeEventDef(0x25, 'semaphore_take_blocking', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ]),
    makeEventDef(0x26, 'semaphore_take_exit', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x27, 'semaphore_reset', [['id', 'uint32_t']]),
    makeEventDef(0x28, 'mutex_init', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x2a, 'mutex_lock_blocking', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ]),
    makeEventDef(0x2b, 'mutex_lock_exit', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x2d, 'mutex_unlock_exit', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x97, 'condvar_init', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x9a, 'condvar_signal_exit', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x9c, 'condvar_broadcast_exit', [
      ['id', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
    makeEventDef(0x9d, 'condvar_wait_enter', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
    ]),
    makeEventDef(0x9e, 'condvar_wait_exit', [
      ['id', 'uint32_t'],
      ['timeout', 'uint32_t'],
      ['ret', 'int32_t'],
    ]),
  ]
  return new Map(defs.map((d) => [d.eid, d]))
}

function runAs(tid: number, ts: number): Uint8Array {
  return record(ts, 0x11, encU32(tid))
}

describe('reconstructSync', () => {
  it('tracks mutex hold, waiter, unlock→lock handoff, and inversion', () => {
    const fork = 0x20001000
    const low = 0x1000
    const high = 0x2000
    const reader = new TraceReader(syncDefs())
    reader.feed(
      Uint8Array.from([
        ...record(1, 0x1a, [...encU32(low), ...encStr('phil_lo', 20)]),
        ...record(2, 0x12, [...encU32(low), 10]),
        ...record(3, 0x1a, [...encU32(high), ...encStr('phil_hi', 20)]),
        ...record(4, 0x12, [...encU32(high), 2]),
        ...record(10, 0x28, [...encU32(fork), ...encI32(0)]),
        ...runAs(low, 20),
        ...record(30, 0x2b, [...encU32(fork), ...encU32(0xffffffff), ...encI32(0)]),
        ...runAs(high, 40),
        ...record(50, 0x2a, [...encU32(fork), ...encU32(0xffffffff)]),
        ...runAs(low, 60),
        ...record(70, 0x2d, [...encU32(fork), ...encI32(0)]),
        ...runAs(high, 80),
        ...record(90, 0x2b, [...encU32(fork), ...encU32(0xffffffff), ...encI32(0)]),
      ]),
    )

    const series = reconstructSync(reader.tr, new Map([[fork, 'fork_1']]))
    expect(series).toHaveLength(1)
    const s = series[0]!
    expect(s.kind).toBe('mutex')
    expect(syncLabel(s)).toBe('fork_1')
    expect(s.holdSegs.length).toBeGreaterThanOrEqual(2)
    expect(s.holdSegs[0]!.ownerId).toBe(low)
    expect(s.holdSegs[0]!.inversion).toBe(true)
    expect(s.waitSegs).toHaveLength(1)
    expect(s.waitSegs[0]!.threadId).toBe(high)
    expect(s.waitSegs[0]!.inversion).toBe(true)
    expect(s.handoffs).toEqual([{ ts: 90, fromId: low, toId: high }])
    expect(s.inversionCount).toBeGreaterThanOrEqual(1)

    const stats = syncWindowStats(series, 0, 100)
    expect(stats.objects).toBe(1)
    expect(stats.handoffs).toBe(1)
    expect(stats.inversions).toBeGreaterThanOrEqual(1)
    expect(stats.waits).toBe(1)
  })

  it('reconstructs semaphore count and give→take handoff', () => {
    const sem = 0x20002000
    const producer = 0x10
    const consumer = 0x20
    const reader = new TraceReader(syncDefs())
    reader.feed(
      Uint8Array.from([
        ...record(1, 0x21, [...encU32(sem), ...encI32(0)]),
        ...runAs(producer, 10),
        ...record(20, 0x23, encU32(sem)), // give → count 1
        ...record(30, 0x23, encU32(sem)), // give → count 2
        ...runAs(consumer, 40),
        ...record(50, 0x26, [...encU32(sem), ...encU32(0), ...encI32(0)]), // take → 1
        ...runAs(consumer, 55),
        ...record(60, 0x25, [...encU32(sem), ...encU32(0xffffffff)]), // block at 0 after next take
        ...record(70, 0x26, [...encU32(sem), ...encU32(0xffffffff), ...encI32(0)]), // take → 0
        ...runAs(consumer, 75),
        ...record(80, 0x25, [...encU32(sem), ...encU32(0xffffffff)]),
        ...runAs(producer, 90),
        ...record(100, 0x23, encU32(sem)), // give while waiter
        ...runAs(consumer, 110),
        ...record(120, 0x26, [...encU32(sem), ...encU32(0xffffffff), ...encI32(0)]),
      ]),
    )

    const [s] = reconstructSync(reader.tr)
    expect(s!.kind).toBe('sem')
    expect(syncCountAt(s!.countSamples, 25)).toBe(1)
    expect(syncCountAt(s!.countSamples, 35)).toBe(2)
    expect(syncCountAt(s!.countSamples, 55)).toBe(1)
    expect(syncCountAt(s!.countSamples, 75)).toBe(0)
    // Give-to-waiter does not bump count; handoff on take_exit.
    expect(syncCountAt(s!.countSamples, 105)).toBe(0)
    expect(s!.handoffs.some((h) => h.fromId === producer && h.toId === consumer)).toBe(true)
    expect(s!.waitSegs.length).toBeGreaterThanOrEqual(1)
  })

  it('records condvar wait and signal', () => {
    const cv = 0x20003000
    const waiter = 0x30
    const signaler = 0x40
    const reader = new TraceReader(syncDefs())
    reader.feed(
      Uint8Array.from([
        ...record(1, 0x97, [...encU32(cv), ...encI32(0)]),
        ...runAs(waiter, 10),
        ...record(20, 0x9d, [...encU32(cv), ...encU32(0xffffffff)]),
        ...runAs(signaler, 30),
        ...record(40, 0x9a, [...encU32(cv), ...encI32(0)]),
        ...runAs(waiter, 50),
        ...record(60, 0x9e, [...encU32(cv), ...encU32(0xffffffff), ...encI32(0)]),
        ...runAs(signaler, 70),
        ...record(80, 0x9c, [...encU32(cv), ...encI32(3)]),
      ]),
    )
    const [s] = reconstructSync(reader.tr)
    expect(s!.kind).toBe('condvar')
    expect(s!.waitSegs).toHaveLength(1)
    expect(s!.waitSegs[0]!.threadId).toBe(waiter)
    expect(s!.marks.some((m) => m.op === 'signal' && m.ok)).toBe(true)
    expect(s!.marks.some((m) => m.op === 'broadcast' && m.value === 3)).toBe(true)
  })

  it('finds the nearest mark for hover tips', () => {
    const reader = new TraceReader(syncDefs())
    const id = 0xabc
    reader.feed(
      Uint8Array.from([
        ...runAs(1, 5),
        ...record(10, 0x28, [...encU32(id), ...encI32(0)]),
        ...record(100, 0x2b, [...encU32(id), ...encU32(0), ...encI32(0)]),
      ]),
    )
    const series = reconstructSync(reader.tr)
    const hit = nearestSyncMark(series, 98, 10)
    expect(hit?.mark.op).toBe('lock')
    expect(nearestSyncMark(series, 50, 5)).toBeNull()
  })
})
