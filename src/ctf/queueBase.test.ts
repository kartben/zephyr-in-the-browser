/**
 * Queue depth once the event log no longer starts with the stream: after the
 * live log drops its oldest events, after a fork, and after a replay restores
 * a decoder checkpoint. Depth is counted from puts and gets, so each of these
 * has to carry what came before (Trace.queueBase) to stay right.
 */

import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { depthAt, dropOldestEvents, reconstructQueues, type QueueSeries } from './queues'
import { TraceReader, type StateSeg, type Trace } from './reader'
import { CONSUMER, MSGQ, PRODUCER, ctfRecord, queueBacklog } from '@/testing/ctfSynth'

const defs = fallbackDefs()
const Q = 0x8000
const FIFO = 0x9000

function decode(bytes: number[] | Uint8Array): TraceReader {
  const reader = new TraceReader(fallbackDefs())
  reader.feed(Uint8Array.from(bytes))
  return reader
}

function series(tr: Trace, id: number): QueueSeries | undefined {
  return reconstructQueues(tr).find((q) => q.id === id)
}

/** Record end offsets and timestamps of `bytes`, as one decode sees them. */
function index(bytes: Uint8Array) {
  const reader = new TraceReader(fallbackDefs())
  const ends: number[] = []
  const times: number[] = []
  reader.onRecord = (end, ts) => {
    ends.push(end)
    times.push(ts)
  }
  reader.feed(bytes)
  return { ends, times }
}

/** Filler that touches no queue: the scheduler going about its business. */
function switches(from: number, count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(...ctfRecord(defs, 'thread_switched_in', from + i * 10, i % 2 ? PRODUCER : CONSUMER))
  }
  return out
}

describe('dropOldestEvents', () => {
  it('keeps what the dropped puts left in a queue', () => {
    const reader = decode([
      ...ctfRecord(defs, 'msgq_put_exit', 100, { id: Q, ret: 0 }),
      ...ctfRecord(defs, 'msgq_put_exit', 200, { id: Q, ret: 0 }),
      ...ctfRecord(defs, 'msgq_put_exit', 300, { id: Q, ret: 0 }),
      ...switches(400, 5),
      ...ctfRecord(defs, 'msgq_get_exit', 900, { id: Q, ret: 0 }),
    ])
    dropOldestEvents(reader.tr, 5)

    const q = series(reader.tr, Q)!
    expect(q.samples).toEqual([
      { ts: 410, depth: 3 },
      { ts: 900, depth: 2 },
    ])
    expect(q.peak).toBe(3)
  })

  it('remembers a receiver already waiting, so its put is a hand-off', () => {
    const reader = decode([
      ...ctfRecord(defs, 'msgq_get_blocking', 100, { id: Q }),
      ...switches(200, 3),
      ...ctfRecord(defs, 'msgq_put_exit', 500, { id: Q, ret: 0 }),
      ...ctfRecord(defs, 'msgq_get_exit', 510, { id: Q, ret: 0 }),
    ])
    dropOldestEvents(reader.tr, 2)

    const q = series(reader.tr, Q)!
    expect(depthAt(q.samples, 505)).toBe(0)
    expect(q.handoffs).toEqual([{ ts: 500, putIndex: 2, getIndex: 3 }])
  })

  it('remembers that an address is a fifo, so its nested queue ops stay hidden', () => {
    const reader = decode([
      ...ctfRecord(defs, 'fifo_put_exit', 100, { id: FIFO }),
      ...ctfRecord(defs, 'queue_append_exit', 110, { id: FIFO }),
      ...switches(200, 3),
      ...ctfRecord(defs, 'queue_get_exit', 590, { id: FIFO, ret: 0xbb }),
      ...ctfRecord(defs, 'fifo_get_exit', 600, { id: FIFO, ret: 0xbb }),
    ])
    dropOldestEvents(reader.tr, 4)

    const q = series(reader.tr, FIFO)!
    expect(q.kind).toBe('fifo')
    expect(depthAt(q.samples, 595)).toBe(1)
    expect(depthAt(q.samples, 600)).toBe(0)
  })

  it('leaves out a queue the dropped events emptied and nothing has touched since', () => {
    const reader = decode([
      ...ctfRecord(defs, 'msgq_put_exit', 100, { id: Q, ret: 0 }),
      ...ctfRecord(defs, 'msgq_get_exit', 200, { id: Q, ret: 0 }),
      ...switches(300, 3),
    ])
    dropOldestEvents(reader.tr, 2)
    expect(series(reader.tr, Q)).toBeUndefined()
  })

  it('agrees with the whole log wherever it is cut', () => {
    const bytes = queueBacklog(60)
    const whole = series(decode(bytes).tr, MSGQ)!
    let held = 0
    for (let k = 1; k < 300; k++) {
      const reader = decode(bytes)
      dropOldestEvents(reader.tr, k)
      if ((reader.tr.queueBase!.objects.get(MSGQ)?.depth ?? 0) > 0) held++
      for (const { ts, depth } of series(reader.tr, MSGQ)!.samples) {
        expect(depthAt(whole.samples, ts), `cut ${k}, at ${ts}`).toBe(depth)
      }
    }
    // Most cuts leave messages behind them; those are the ones that matter.
    expect(held).toBeGreaterThan(100)
  })

  it('agrees with the whole log however many times it is cut', () => {
    const bytes = queueBacklog(2_000)
    const whole = series(decode(bytes).tr, MSGQ)!
    const reader = decode(bytes)
    for (const n of [37, 500, 1_001, 2_000]) dropOldestEvents(reader.tr, n)

    const cut = series(reader.tr, MSGQ)!
    expect(cut.samples.length).toBeGreaterThan(100)
    for (const { ts, depth } of cut.samples) expect(depthAt(whole.samples, ts), `at ${ts}`).toBe(depth)
  })
})

describe('a fork', () => {
  it('starts with the queues as they stood', () => {
    const bytes = queueBacklog(200)
    const { ends, times } = index(bytes)
    const whole = series(decode(bytes).tr, MSGQ)!
    // Fork just after a put that left the queue at its deepest.
    const deepest = whole.samples.reduce((a, b) => (b.depth > a.depth ? b : a))
    expect(deepest.depth).toBeGreaterThan(1)
    const k = times.indexOf(deepest.ts) + 1
    const head = decode(bytes.subarray(0, ends[k - 1]))
    const fork = head.fork()
    fork.feed(bytes.subarray(ends[k - 1]))

    const forked = series(fork.tr, MSGQ)!
    expect(forked.samples[0]).toEqual(deepest)
    expect(forked.samples.length).toBeGreaterThan(50)
    for (const { ts, depth } of forked.samples) expect(depthAt(whole.samples, ts)).toBe(depth)
  })
})

describe('TraceReader checkpoints', () => {
  const bytes = queueBacklog(400)
  const whole = (() => {
    const reader = new TraceReader(fallbackDefs())
    reader.checkpointEvery = 300
    reader.feed(bytes)
    return reader
  })()

  it('are taken every so many records, at record boundaries', () => {
    const { ends, times } = index(bytes)
    const records = index(bytes).ends.length
    expect(whole.checkpoints.map((cp) => cp.records)).toEqual(
      Array.from({ length: Math.floor(records / 300) }, (_, i) => (i + 1) * 300),
    )
    for (const cp of whole.checkpoints) {
      expect(cp.byte).toBe(ends[cp.records - 1])
      expect(cp.ts).toBe(times[cp.records - 1])
    }
  })

  it('decode on to the same trace as the reader that took them', () => {
    for (const cp of whole.checkpoints) {
      const restored = TraceReader.fromCheckpoint(fallbackDefs(), true, cp, whole.tr)
      restored.feed(bytes.subarray(cp.byte))
      const tr = restored.tr

      expect(tr.t0).toBe(whole.tr.t0)
      expect(tr.t1).toBe(whole.tr.t1)
      expect(tr.events).toEqual(whole.tr.events.slice(cp.records))
      expect(tr.states).toEqual(whole.tr.states)
      expect(tr.stateStarts).toEqual(whole.tr.stateStarts)
      expect(tr.segments).toEqual(whole.tr.segments)
      expect(tr.isrSpans).toEqual(whole.tr.isrSpans)
      expect(tr.threads).toEqual(whole.tr.threads)
      const depth = series(whole.tr, MSGQ)!.samples
      for (const { ts, depth: d } of series(tr, MSGQ)!.samples) expect(depthAt(depth, ts)).toBe(d)
    }
  })

  it('can be restored again and again, changing nothing they came from', () => {
    const before = structuredClone(whole.tr)
    const cp = whole.checkpoints[4]!
    const runs = [0, 1].map(() => {
      const restored = TraceReader.fromCheckpoint(fallbackDefs(), true, cp, whole.tr)
      restored.feed(bytes.subarray(cp.byte))
      return restored.tr
    })
    expect(runs[0]).toEqual(runs[1])
    expect(whole.tr).toEqual(before)
  })

  it('hold every thread’s state before the bytes after them arrive', () => {
    const cp = whole.checkpoints[2]!
    const restored = TraceReader.fromCheckpoint(fallbackDefs(), true, cp, whole.tr)
    const open = (tr: Trace, tid: number): StateSeg | undefined =>
      tr.states.get(tid)?.find(([s, e]) => s <= cp.ts && cp.ts < e)
    for (const tid of [PRODUCER.thread_id, CONSUMER.thread_id]) {
      expect(restored.tr.states.get(tid)?.at(-1)?.[2], `0x${tid.toString(16)}`).toBe(open(whole.tr, tid)?.[2])
    }
  })
})
