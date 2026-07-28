import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader } from './reader'
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
    expect(queueAxisMax(s!)).toBe(2)
    expect(depthAt(s!.samples, 350)).toBe(2)
    expect(depthAt(s!.samples, 450)).toBe(1)
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
        ...record(100, 0x128, [...encU32(id), ...encU32(0xaa)]), // fifo_put_exit
        ...record(110, 0x10c, [...encU32(id)]), // nested queue_append_exit (ignored)
        ...record(200, 0x130, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // fifo_get_exit ok
        ...record(210, 0x11c, [...encU32(id), ...encU32(0), ...encU32(0xbb)]), // nested queue_get
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
        ...record(100, 0x128, [...encU32(id), ...encU32(1)]),
        ...record(200, 0x130, [...encU32(id), ...encU32(0), ...encU32(0)]), // timeout / empty
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
        ...record(100, 0x10c, [...encU32(id)]), // queue_append_exit
        ...record(200, 0x110, [...encU32(id)]), // queue_prepend_exit
        ...record(300, 0x11c, [...encU32(id), ...encU32(0), ...encU32(0x11)]), // get
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
        ...record(100, 0x138, [...encU32(id), ...encU32(1)]), // lifo_put_exit
        ...record(110, 0x110, [...encU32(id)]), // nested queue_prepend (ignored)
        ...record(200, 0x13c, [...encU32(id), ...encU32(0), ...encU32(0x22)]),
      ]),
    )
    const [s] = reconstructQueues(reader.tr)
    expect(s!.kind).toBe('lifo')
    expect(depthAt(s!.samples, 150)).toBe(1)
    expect(depthAt(s!.samples, 250)).toBe(0)
  })
})
