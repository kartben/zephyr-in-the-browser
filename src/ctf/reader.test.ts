import { describe, expect, it } from 'vitest'
import { fallbackDefs, makeEventDef } from './metadata'
import {
  TraceReader,
  laneOrder,
  threadLabel,
  threadPrio,
  renderStateRows,
  fmtTime,
  fmtAxisTime,
  niceTimeStep,
  timeTickValues,
  threadRunningAt,
  stateAt,
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
function encI8(n: number): number[] {
  return [n & 0xff]
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
    // No prio yet — stable tid order (a < b), not busy time.
    const order = laneOrder(reader.tr)
    expect(order).toEqual([a, b])
    const rows = renderStateRows(reader.tr, order, reader.tr.t0, reader.tr.t1, 10)
    expect(rows.get(a)?.some((c) => c === 'run')).toBe(true)
    expect(rows.get(b)?.some((c) => c === 'run')).toBe(true)
  })

  it('orders Gantt lanes by Zephyr priority (lower = higher), unknown last', () => {
    const reader = new TraceReader(fallbackDefs())
    const coop = 0x1000
    const preempt = 0x2000
    const unknown = 0x3000
    const bytes = [
      ...record(100, 0x13, [...encU32(preempt), ...encName('preempt')]),
      ...record(110, 0x13, [...encU32(coop), ...encName('coop')]),
      ...record(120, 0x13, [...encU32(unknown), ...encName('unknown')]),
      // thread_priority_set: prio 7 then -2 (busy spans must not affect order).
      ...record(200, 0x12, [...encU32(preempt), ...encName('preempt'), ...encI8(7)]),
      ...record(210, 0x12, [...encU32(coop), ...encName('coop'), ...encI8(-2)]),
      ...record(1000, 0x11, [...encU32(preempt), ...encName('preempt')]),
      ...record(5000, 0x10, [...encU32(preempt), ...encName('preempt')]),
      ...record(5000, 0x11, [...encU32(coop), ...encName('coop')]),
      ...record(5500, 0x10, [...encU32(coop), ...encName('coop')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(threadPrio(reader.tr, coop)).toBe(-2)
    expect(threadPrio(reader.tr, preempt)).toBe(7)
    expect(threadPrio(reader.tr, unknown)).toBeNull()
    expect(laneOrder(reader.tr)).toEqual([coop, preempt, unknown])
  })

  it('keeps equal-prio lane order stable regardless of busy time', () => {
    const reader = new TraceReader(fallbackDefs())
    const lowBusy = 0x1000
    const highBusy = 0x2000
    const bytes = [
      ...record(100, 0x13, [...encU32(highBusy), ...encName('busy')]),
      ...record(110, 0x13, [...encU32(lowBusy), ...encName('quiet')]),
      ...record(200, 0x12, [...encU32(highBusy), ...encName('busy'), ...encI8(5)]),
      ...record(210, 0x12, [...encU32(lowBusy), ...encName('quiet'), ...encI8(5)]),
      // highBusy runs much longer — must not leapfrog lowBusy.
      ...record(1000, 0x11, [...encU32(highBusy), ...encName('busy')]),
      ...record(9000, 0x10, [...encU32(highBusy), ...encName('busy')]),
      ...record(9000, 0x11, [...encU32(lowBusy), ...encName('quiet')]),
      ...record(9100, 0x10, [...encU32(lowBusy), ...encName('quiet')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(laneOrder(reader.tr)).toEqual([lowBusy, highBusy])
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

  it('does not report the interrupted thread as running inside a closed or live ISR', () => {
    const reader = new TraceReader(fallbackDefs())
    const thread = 0x1000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(thread), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(thread), ...encName('worker')]),
        ...record(200, 0x1b, []),
      ]),
    )

    // The outer ISR is still open at the live edge.
    expect(threadRunningAt(reader.tr, 250)).toBeNull()

    reader.feed(record(300, 0x1c, []))
    expect(threadRunningAt(reader.tr, 199)).toBe(thread)
    expect(threadRunningAt(reader.tr, 200)).toBeNull()
    expect(threadRunningAt(reader.tr, 299)).toBeNull()
    expect(threadRunningAt(reader.tr, 300)).toBe(thread)
  })

  it('closes an ISR span at the next context switch when its exit was dropped', () => {
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const worker = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(worker), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        ...record(200, 0x1b, []),
        // ISR exit and switched_out were dropped; switched_in proves it ended.
        ...record(300, 0x11, [...encU32(worker), ...encName('worker')]),
      ]),
    )

    expect(reader.tr.isrOpenStart).toBeNull()
    expect(reader.tr.isrSpans).toContainEqual([200, 300])
    expect(threadRunningAt(reader.tr, 250)).toBeNull()
    expect(threadRunningAt(reader.tr, 300)).toBe(worker)
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

  it('fmtAxisTime picks a unit from the tick step', () => {
    expect(fmtAxisTime(12_400_000, 200_000)).toBe('12.400ms')
    expect(fmtAxisTime(1_500, 500)).toBe('1.500µs')
    expect(fmtAxisTime(2_500_000_000, 1_000_000_000)).toBe('2.500s')
    // Past 1s → seconds even when the step is still in the ms ladder.
    expect(fmtAxisTime(5_776_375_000, 100_000)).toBe('5.7764s')
  })

  it('timeTickValues walks the nice step across the window', () => {
    const { values, step } = timeTickValues(0, 1_000_000_000, 5)
    expect(step).toBe(200_000_000)
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1_000_000_000)
    expect(values).toHaveLength(6)
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

  it('sync CTF: threadRunningAt follows switched_out then switched_in', () => {
    // msg_queue / SYNC semihost: Zephyr emits a clean out→in pair.
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const worker = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(worker), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        ...record(200, 0x10, [...encU32(main), ...encName('main')]),
        ...record(200, 0x11, [...encU32(worker), ...encName('worker')]),
        ...record(300, 0x10, [...encU32(worker), ...encName('worker')]),
      ]),
    )
    expect(threadRunningAt(reader.tr, 150)).toBe(main)
    expect(threadRunningAt(reader.tr, 250)).toBe(worker)
    expect(threadRunningAt(reader.tr, 350)).toBeNull()
    // Only one runner at the switch instant — out closes main before in.
    expect(stateAt(reader.tr, main, 200)[0]).not.toBe('run')
  })

  it('async CTF: threadRunningAt recovers when switched_out is missing', () => {
    // http_server / ASYNC: ring drops can skip switched_out; demote on in.
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const rx = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(rx), ...encName('rx_q')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        // Missing switched_out for main — only switched_in for rx.
        ...record(200, 0x11, [...encU32(rx), ...encName('rx_q')]),
      ]),
    )
    expect(threadRunningAt(reader.tr, 250)).toBe(rx)
    expect(threadRunningAt(reader.tr, 150)).toBe(main)
    // Demote must clear main so Map-order scan cannot pin edges on it.
    expect(stateAt(reader.tr, main, 250)[0]).not.toBe('run')
  })
})
