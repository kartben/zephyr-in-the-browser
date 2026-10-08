/**
 * TraceReader.fork, extendTo and record offsets: what a Trace recording and its
 * replay are built on (traceRecorder.ts, tracePlayback.ts).
 */

import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader, stateAt, type StateSeg } from './reader'
import { CONSUMER, PRODUCER, ctfRecord, producerConsumer } from '@/testing/ctfSynth'

/** Record end offsets of `bytes`, in order. */
function recordEnds(bytes: Uint8Array): number[] {
  const reader = new TraceReader(fallbackDefs())
  const ends: number[] = []
  reader.onRecord = (end) => ends.push(end)
  reader.feed(bytes)
  return ends
}

/** `segs` as they look from `from` on: earlier ones dropped, the straddling one cut. */
function clip<T extends [number, number, ...unknown[]]>(segs: readonly T[], from: number): T[] {
  return segs.filter((seg) => seg[1] > from).map((seg) => [Math.max(seg[0], from), ...seg.slice(1)] as T)
}

describe('TraceReader.fork', () => {
  const bytes = producerConsumer(40)
  const ends = recordEnds(bytes)
  // Mid-round, with the consumer blocked on the msgq and the producer asleep.
  const split = ends[17 * 20 + 15 - 1]!

  it('decodes the rest of a stream as the reader it forked from would have', () => {
    const whole = new TraceReader(fallbackDefs())
    whole.feed(bytes)

    const head = new TraceReader(fallbackDefs())
    head.feed(bytes.subarray(0, split))
    const fork = head.fork()
    const at = head.tr.t1
    fork.feed(bytes.subarray(split))

    expect(fork.tr.t0).toBe(at)
    expect(fork.tr.t1).toBe(whole.tr.t1)
    expect(fork.tr.events).toEqual(whole.tr.events.filter((e) => e.ts > at))
    for (const tid of whole.tr.states.keys()) {
      expect(fork.tr.states.get(tid), `thread 0x${tid.toString(16)}`).toEqual(
        clip<StateSeg>(whole.tr.states.get(tid)!, at),
      )
    }
    expect(fork.tr.segments).toEqual(clip(whole.tr.segments, at))
    expect(fork.tr.isrSpans).toEqual(clip(whole.tr.isrSpans, at))
  })

  it('knows every thread and what it is doing before its first record', () => {
    const head = new TraceReader(fallbackDefs())
    head.feed(bytes.subarray(0, split))
    const fork = head.fork()
    const at = head.tr.t1

    expect(fork.tr.events).toEqual([])
    expect(fork.tr.threads.get(CONSUMER.thread_id)?.name).toBe('consumer')
    expect(stateAt(fork.tr, CONSUMER.thread_id, at)).toEqual(stateAt(head.tr, CONSUMER.thread_id, at))
    expect(stateAt(fork.tr, PRODUCER.thread_id, at)[0]).toBe('slp')
  })

  it('leaves the reader it forked from alone', () => {
    const head = new TraceReader(fallbackDefs())
    head.feed(bytes.subarray(0, split))
    const before = structuredClone(head.tr)
    head.fork().feed(bytes.subarray(split))
    expect(head.tr).toEqual(before)
  })

  it('carries on mid-record once given the bytes held back', () => {
    const whole = new TraceReader(fallbackDefs())
    whole.feed(bytes)

    const head = new TraceReader(fallbackDefs())
    head.feed(bytes.subarray(0, split + 5))
    const fork = head.fork()
    fork.feed(head.pendingBytes)
    fork.feed(bytes.subarray(split + 5))

    expect(head.pendingBytes.length).toBe(5)
    expect(fork.tr.events).toEqual(whole.tr.events.filter((e) => e.ts > head.tr.t1))
  })

  it('of a fork starts at the same place', () => {
    const head = new TraceReader(fallbackDefs())
    head.feed(bytes.subarray(0, split))
    const fork = head.fork()
    const again = fork.fork()
    expect(again.forkedAt).toBe(head.tr.t1)
    again.feed(bytes.subarray(split))
    fork.feed(bytes.subarray(split))
    expect(again.tr).toEqual(fork.tr)
  })

  it('of a reader with nothing decoded starts like a new one', () => {
    const fork = new TraceReader(fallbackDefs()).fork()
    expect(fork.forkedAt).toBeNull()
    fork.feed(bytes)
    expect(fork.tr.t0).toBe(1_000_000)
  })
})

describe('TraceReader.extendTo', () => {
  const defs = fallbackDefs()
  const bytes = Uint8Array.from([
    ...ctfRecord(defs, 'thread_switched_in', 1_000, PRODUCER),
    ...ctfRecord(defs, 'thread_switched_out', 2_000, PRODUCER),
    ...ctfRecord(defs, 'thread_switched_in', 2_000, CONSUMER),
  ])

  it('holds every state up to the new time', () => {
    const reader = new TraceReader(fallbackDefs())
    reader.feed(bytes)
    reader.extendTo(9_000)

    expect(reader.tr.t1).toBe(9_000)
    expect(reader.tr.states.get(CONSUMER.thread_id)?.at(-1)).toEqual([2_000, 9_000, 'run', '', null])
    expect(stateAt(reader.tr, PRODUCER.thread_id, 8_999)[0]).toBe('rdy')
  })

  it('comes back down as far as the newest record, and no further', () => {
    const reader = new TraceReader(fallbackDefs())
    reader.feed(bytes)
    reader.extendTo(9_000)
    reader.extendTo(5_000)
    expect(reader.tr.t1).toBe(5_000)
    expect(reader.tr.states.get(CONSUMER.thread_id)?.at(-1)?.[1]).toBe(5_000)

    reader.extendTo(1_500)
    expect(reader.tr.t1).toBe(5_000)
  })

  it('lets the next record carry on from there', () => {
    const reader = new TraceReader(fallbackDefs())
    reader.feed(bytes)
    reader.extendTo(5_000)
    reader.feed(Uint8Array.from(ctfRecord(defs, 'thread_switched_out', 6_000, CONSUMER)))

    expect(reader.tr.t1).toBe(6_000)
    expect(reader.tr.states.get(CONSUMER.thread_id)?.filter(([, , st]) => st === 'run')).toEqual([
      [2_000, 6_000, 'run', '', null],
    ])
  })
})

describe('TraceReader.onRecord', () => {
  it('reports each record’s end as a stream offset, across feeds', () => {
    const bytes = producerConsumer(2)
    const reader = new TraceReader(fallbackDefs())
    const ends: number[] = []
    reader.onRecord = (end) => ends.push(end)
    for (let off = 0; off < bytes.length; off += 7) reader.feed(bytes.subarray(off, off + 7))

    // isr_enter + isr_exit (10 bytes each), then a 34-byte switch.
    expect(ends.slice(0, 3)).toEqual([10, 20, 54])
    expect(ends.at(-1)).toBe(bytes.length)
    expect(ends).toHaveLength(34)
  })
})
