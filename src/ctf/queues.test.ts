import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader } from './reader'
import {
  FIFO_GET_EXIT,
  FIFO_PUT_EXIT,
  LIFO_GET_EXIT,
  LIFO_PUT_EXIT,
  QUEUE_APPEND_EXIT,
  QUEUE_GET_BLOCKING,
  QUEUE_GET_EXIT,
  QUEUE_PREPEND_EXIT,
  STACK_POP_BLOCKING,
  STACK_POP_EXIT,
  STACK_PUSH_EXIT,
} from './types'
import { depthAt, queueAxisMax, queueLabel, reconstructQueues } from './queues'

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

function record(ts: number, eid: number, body: number[]): number[] {
  return [...encU64(ts), ...encU16(eid), ...body]
}

/** msgq_put_exit / get_exit body: id, timeout, ret */
function putExit(ts: number, id: number, ret: number): number[] {
  return record(ts, 0x8c, [...encU32(id), ...encU32(0), ...encI32(ret)])
}
function getExit(ts: number, id: number, ret: number): number[] {
  return record(ts, 0x8f, [...encU32(id), ...encU32(0), ...encI32(ret)])
}
function purge(ts: number, id: number): number[] {
  return record(ts, 0x91, [...encU32(id)])
}
/** A receiver about to wait: msgq_get_blocking, queue_get_blocking, stack_pop_blocking. */
function getBlocking(ts: number, id: number, eid = 0x8e): number[] {
  return record(ts, eid, [...encU32(id), ...encU32(0xffffffff)])
}

describe('reconstructQueues', () => {
  it('replays depth from successful put/get exits', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20001000
    reader.feed(
      Uint8Array.from([
        ...putExit(1000, q, 0),
        ...putExit(2000, q, 0),
        ...getExit(3000, q, 0),
        ...putExit(4000, q, 0),
      ]),
    )
    const series = reconstructQueues(reader.tr)
    expect(series).toHaveLength(1)
    expect(series[0]!.id).toBe(q)
    expect(series[0]!.kind).toBe('msgq')
    expect(depthAt(series[0]!.samples, 1500)).toBe(1)
    expect(depthAt(series[0]!.samples, 2500)).toBe(2)
    expect(depthAt(series[0]!.samples, 3500)).toBe(1)
    expect(depthAt(series[0]!.samples, 4500)).toBe(2)
    expect(series[0]!.peak).toBe(2)
    expect(series[0]!.drops).toBe(0)
    expect(series[0]!.cap).toBeNull()
    expect(series[0]!.capSource).toBeNull()
  })

  it('counts failed puts as drops and infers capacity', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20002000
    // Fill to 2, then fail a put → cap=2, drops=1.
    reader.feed(
      Uint8Array.from([
        ...putExit(100, q, 0),
        ...putExit(200, q, 0),
        ...putExit(300, q, -11), // -EAGAIN
        ...getExit(400, q, 0),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.drops).toBe(1)
    expect(s!.cap).toBe(2)
    expect(s!.capSource).toBe('inferred')
    expect(queueAxisMax(s!)).toBe(2)
    expect(depthAt(s!.samples, 350)).toBe(2)
    expect(depthAt(s!.samples, 450)).toBe(1)
  })

  it('uses the object-core capacity without waiting to observe a full queue', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20002500
    reader.feed(Uint8Array.from([...putExit(100, q, 0), ...putExit(200, q, 0)]))

    const [series] = reconstructQueues(
      reader.tr,
      new Map([[q, 'bounded_queue']]),
      new Map([[q, 8]]),
    )

    expect(series).toMatchObject({
      name: 'bounded_queue',
      peak: 2,
      cap: 8,
      capSource: 'object-core',
    })
    expect(queueAxisMax(series!)).toBe(8)
  })

  it('resets depth on purge and resolves ELF names', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20003000
    reader.feed(
      Uint8Array.from([...putExit(10, q, 0), ...putExit(20, q, 0), ...purge(30, q)]),
    )
    const names = new Map([[q, 'q_log']])
    const [s] = reconstructQueues(reader.tr, names)
    expect(queueLabel(s!)).toBe('q_log')
    expect(depthAt(s!.samples, 25)).toBe(2)
    expect(depthAt(s!.samples, 35)).toBe(0)
  })

  it('tracks multiple queues independently', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    reader.feed(
      Uint8Array.from([
        ...putExit(1, b, 0),
        ...putExit(2, a, 0),
        ...putExit(3, a, 0),
        ...getExit(4, b, 0),
      ]),
    )
    const series = reconstructQueues(
      reader.tr,
      new Map([
        [a, 'q_events'],
        [b, 'q_shell'],
      ]),
    )
    expect(series.map((s) => s.name)).toEqual(['q_events', 'q_shell'])
    expect(depthAt(series[0]!.samples, 10)).toBe(2)
    expect(depthAt(series[1]!.samples, 10)).toBe(0)
  })

  it('counts fifo put/get once and hides nested queue_* for the same id', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x3000
    // Zephyr dual-layer: fifo_put → queue_append → fifo_put_exit, then get.
    reader.feed(
      Uint8Array.from([
        ...record(100, FIFO_PUT_EXIT, [...encU32(id), ...encU32(0xaa)]),
        ...record(110, QUEUE_APPEND_EXIT, [...encU32(id)]), // nested (ignored)
        ...record(200, FIFO_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // ok
        ...record(210, QUEUE_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // nested
      ]),
    )
    const series = reconstructQueues(reader.tr)
    expect(series).toHaveLength(1)
    expect(series[0]!.kind).toBe('fifo')
    expect(depthAt(series[0]!.samples, 150)).toBe(1)
    expect(depthAt(series[0]!.samples, 250)).toBe(0)
    expect(series[0]!.peak).toBe(1)
    expect(series[0]!.cap).toBeNull()
  })

  it('does not decrease depth on failed pointer get (ret=0)', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x4000
    reader.feed(
      Uint8Array.from([
        ...record(100, FIFO_PUT_EXIT, [...encU32(id), ...encU32(1)]),
        ...record(200, FIFO_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0)]), // timeout / empty
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 250)).toBe(1)
  })

  it('reconstructs bare k_queue append/get', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x5000
    reader.feed(
      Uint8Array.from([
        ...record(100, QUEUE_APPEND_EXIT, [...encU32(id)]),
        ...record(200, QUEUE_PREPEND_EXIT, [...encU32(id)]),
        ...record(300, QUEUE_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0x11)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.kind).toBe('queue')
    expect(depthAt(s!.samples, 150)).toBe(1)
    expect(depthAt(s!.samples, 250)).toBe(2)
    expect(depthAt(s!.samples, 350)).toBe(1)
  })

  it('treats lifo put as depth +1', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x6000
    reader.feed(
      Uint8Array.from([
        ...record(100, LIFO_PUT_EXIT, [...encU32(id), ...encU32(1)]),
        ...record(110, QUEUE_PREPEND_EXIT, [...encU32(id)]), // nested (ignored)
        ...record(200, LIFO_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0x22)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.kind).toBe('lifo')
    expect(depthAt(s!.samples, 150)).toBe(1)
    expect(depthAt(s!.samples, 250)).toBe(0)
  })

  it('tracks k_stack push/pop depth', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x7000
    reader.feed(
      Uint8Array.from([
        ...record(100, STACK_PUSH_EXIT, [...encU32(id), ...encI32(0)]),
        ...record(200, STACK_PUSH_EXIT, [...encU32(id), ...encI32(0)]),
        ...record(300, STACK_POP_EXIT, [...encU32(id), ...encU32(0), ...encI32(0)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.kind).toBe('stack')
    expect(depthAt(s!.samples, 150)).toBe(1)
    expect(depthAt(s!.samples, 250)).toBe(2)
    expect(depthAt(s!.samples, 350)).toBe(1)
  })
  it('keeps a msgq hand-off to a waiting receiver out of the depth', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20003000
    reader.feed(
      Uint8Array.from([
        ...getBlocking(100, q), // the receiver waits on an empty queue
        ...putExit(200, q, 0), // the sender's message goes straight to it
        ...getExit(210, q, 0), // the receiver returns with it
        ...putExit(300, q, 0), // nobody waiting: this one is queued
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 150)).toBe(0)
    expect(depthAt(s!.samples, 205)).toBe(0)
    expect(depthAt(s!.samples, 250)).toBe(0)
    expect(depthAt(s!.samples, 350)).toBe(1)
    expect(s!.peak).toBe(1)
    expect(s!.handoffs).toEqual([{ ts: 200, putIndex: 1, getIndex: 2 }])
  })

  it('counts a put normally once the waiting receiver has timed out', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20004000
    reader.feed(
      Uint8Array.from([
        ...getBlocking(100, q),
        ...getExit(200, q, -11), // -EAGAIN
        ...putExit(300, q, 0),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 250)).toBe(0)
    expect(depthAt(s!.samples, 350)).toBe(1)
    expect(s!.handoffs).toEqual([])
  })

  it('hands one put to each waiting receiver and queues the rest', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20005000
    reader.feed(
      Uint8Array.from([
        ...getBlocking(100, q), // A waits
        ...getBlocking(110, q), // B waits
        ...putExit(200, q, 0), // to A
        ...getExit(205, q, 0), // A returns
        ...putExit(300, q, 0), // to B
        ...putExit(310, q, 0), // B already has one: queued
        ...getExit(320, q, 0), // B returns with the hand-off
        ...getExit(400, q, 0), // someone takes the queued one
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 305)).toBe(0)
    expect(depthAt(s!.samples, 315)).toBe(1)
    expect(depthAt(s!.samples, 350)).toBe(1)
    expect(depthAt(s!.samples, 450)).toBe(0)
    expect(s!.handoffs.map((h) => [h.ts, h.getIndex])).toEqual([
      [200, 3],
      [300, 6],
    ])
  })

  it('keeps a fifo hand-off flat when the receiver returns before the put exits', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x3100
    // k_queue traces the put's exit after the reschedule, so the receiver
    // that was waiting returns first.
    reader.feed(
      Uint8Array.from([
        ...getBlocking(100, id, QUEUE_GET_BLOCKING), // nested, same id
        ...record(200, FIFO_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // ok
        ...record(201, QUEUE_GET_EXIT, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // nested
        ...record(210, FIFO_PUT_EXIT, [...encU32(id), ...encU32(0xbb)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.kind).toBe('fifo')
    expect(depthAt(s!.samples, 205)).toBe(0)
    expect(depthAt(s!.samples, 250)).toBe(0)
    expect(s!.peak).toBe(0)
    expect(s!.handoffs).toEqual([{ ts: 210, putIndex: 3, getIndex: 1 }])
  })

  it('keeps a k_stack hand-off flat', () => {
    const reader = new TraceReader(fallbackDefs())
    const id = 0x7100
    reader.feed(
      Uint8Array.from([
        ...getBlocking(100, id, STACK_POP_BLOCKING),
        ...record(200, STACK_POP_EXIT, [...encU32(id), ...encU32(0), ...encI32(0)]),
        ...record(210, STACK_PUSH_EXIT, [...encU32(id), ...encI32(0)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 250)).toBe(0)
    expect(s!.handoffs).toHaveLength(1)
  })

  it('does not dip when a get on a full msgq moves a blocked sender in', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x20006000
    // Full at 2 with a sender blocked. The get that makes room moves the
    // sender's message in, and traces msgq_get_blocking while it does.
    reader.feed(
      Uint8Array.from([
        ...putExit(100, q, 0),
        ...putExit(110, q, 0),
        ...getBlocking(200, q),
        ...getExit(201, q, 0),
        ...putExit(300, q, 0), // the blocked sender returns
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(depthAt(s!.samples, 150)).toBe(2)
    expect(depthAt(s!.samples, 250)).toBe(2)
    expect(depthAt(s!.samples, 350)).toBe(2)
    expect(s!.handoffs).toEqual([])
  })
})
