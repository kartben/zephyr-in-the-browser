import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader } from './reader'
import {
  isPutOp,
  mouthForOp,
  nearestQueueChartEvent,
  queueChartEvents,
  queueChartOpLabel,
  queueFlowEvents,
  advanceFlowCursor,
  sortQueuesByPipelineOrder,
  threadFlowScores,
} from './queueGraph'

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
function encName(s: string): number[] {
  const out = Array.from({ length: 20 }, () => 0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): number[] {
  return [...encU64(ts), ...encU16(eid), ...body]
}

describe('queueFlowEvents', () => {
  it('attributes put/get exits to the running thread at that timestamp', () => {
    const reader = new TraceReader(fallbackDefs())
    const thr = 0x1000
    const q = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(thr), ...encName('producer')]),
        ...record(100, 0x11, [...encU32(thr), ...encName('producer')]),
        ...record(200, 0x8c, [...encU32(q), ...encU32(0), ...encI32(0)]),
        ...record(300, 0x8f, [...encU32(q), ...encU32(0), ...encI32(0)]),
        ...record(400, 0x8c, [...encU32(q), ...encU32(0), ...encI32(-11)]),
      ]),
    )
    const flow = queueFlowEvents(reader.tr)
    expect(flow).toHaveLength(3)
    expect(flow[0]).toMatchObject({ op: 'put', queueId: q, threadId: thr, ok: true })
    expect(flow[1]).toMatchObject({ op: 'get', queueId: q, threadId: thr, ok: true })
    expect(flow[2]).toMatchObject({ op: 'put', ok: false })
    const scores = threadFlowScores(flow)
    // One put + one get (failed put ignored) ⇒ score 0.
    expect(scores.get(thr)).toBe(0)
  })

  it('treats msgq_put_front_exit as a distinct producer-side put_front op', () => {
    const reader = new TraceReader(fallbackDefs())
    const thr = 0x1000
    const q = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(thr), ...encName('producer')]),
        ...record(100, 0x11, [...encU32(thr), ...encName('producer')]),
        ...record(200, 0x93, [...encU32(q), ...encU32(0), ...encI32(0)]),
        ...record(300, 0x8f, [...encU32(q), ...encU32(0), ...encI32(0)]),
      ]),
    )
    const flow = queueFlowEvents(reader.tr)
    expect(flow).toHaveLength(2)
    expect(flow[0]).toMatchObject({ op: 'put_front', queueId: q, threadId: thr, ok: true })
    expect(flow[1]).toMatchObject({ op: 'get', queueId: q, threadId: thr, ok: true })
    expect(isPutOp('put_front')).toBe(true)
    expect(isPutOp('put')).toBe(true)
    expect(isPutOp('get')).toBe(false)
    // put_front scores like put (+1), then get (−1) ⇒ 0.
    expect(threadFlowScores(flow).get(thr)).toBe(0)
  })

  it('maps ops to Zephyr msgq end/front mouths', () => {
    // k_msgq_put → end; k_msgq_put_front + k_msgq_get → front (head).
    expect(mouthForOp('put')).toBe('end')
    expect(mouthForOp('put_front')).toBe('front')
    expect(mouthForOp('get')).toBe('front')
  })
})

describe('queueChartEvents / nearestQueueChartEvent', () => {
  it('includes purge alongside put/get exits', () => {
    const reader = new TraceReader(fallbackDefs())
    const thr = 0x1000
    const q = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(thr), ...encName('producer')]),
        ...record(100, 0x11, [...encU32(thr), ...encName('producer')]),
        ...record(200, 0x8c, [...encU32(q), ...encU32(0), ...encI32(0)]),
        ...record(300, 0x91, [...encU32(q)]),
      ]),
    )
    const chart = queueChartEvents(reader.tr)
    expect(chart).toHaveLength(2)
    expect(chart[0]).toMatchObject({ op: 'put', ok: true, threadId: thr })
    expect(chart[1]).toMatchObject({ op: 'purge', ok: true, queueId: q, threadId: thr })
    expect(queueChartOpLabel('purge')).toBe('purge')
  })

  it('picks the nearest event for a queue within the delta window', () => {
    const reader = new TraceReader(fallbackDefs())
    const q = 0x2000
    const other = 0x2001
    reader.feed(
      Uint8Array.from([
        ...record(100, 0x8c, [...encU32(q), ...encU32(0), ...encI32(0)]),
        ...record(200, 0x8c, [...encU32(other), ...encU32(0), ...encI32(0)]),
        ...record(400, 0x8f, [...encU32(q), ...encU32(0), ...encI32(0)]),
      ]),
    )
    const chart = queueChartEvents(reader.tr)
    // 150 from put@100 — within 80 → put; other@200 ignored for this queue.
    expect(nearestQueueChartEvent(chart, q, 150, 80)?.op).toBe('put')
    expect(nearestQueueChartEvent(chart, q, 150, 80)?.ts).toBe(100)
    // Closer to get@400.
    expect(nearestQueueChartEvent(chart, q, 350, 80)?.op).toBe('get')
    // Midway with a tight window → nothing for q (other's put must not win).
    expect(nearestQueueChartEvent(chart, q, 250, 40)).toBeNull()
    expect(nearestQueueChartEvent(chart, other, 200, 10)?.queueId).toBe(other)
  })
})

describe('advanceFlowCursor', () => {
  it('returns first/delta normally and recovers after an index rewind (trim)', () => {
    const flow = [
      { index: 10, ts: 1, op: 'put' as const, queueId: 1, threadId: 1, ok: true },
      { index: 11, ts: 2, op: 'get' as const, queueId: 1, threadId: 1, ok: true },
      { index: 20, ts: 3, op: 'put' as const, queueId: 1, threadId: 1, ok: true },
    ]
    expect(advanceFlowCursor(flow, -1)).toMatchObject({ kind: 'first', nextIndex: 20, newest: [] })
    const delta = advanceFlowCursor(flow, 10)
    expect(delta.kind).toBe('delta')
    expect(delta.newest.map((e) => e.index)).toEqual([11, 20])
    expect(delta.nextIndex).toBe(20)

    // After hostTrace trims the ring, indices restart — must not stall.
    const trimmed = [
      { index: 0, ts: 100, op: 'put' as const, queueId: 1, threadId: 1, ok: true },
      { index: 1, ts: 101, op: 'get' as const, queueId: 1, threadId: 1, ok: true },
    ]
    const rewind = advanceFlowCursor(trimmed, 20)
    expect(rewind).toMatchObject({ kind: 'trimmed', nextIndex: 1, newest: [] })
    const after = advanceFlowCursor(
      [
        ...trimmed,
        { index: 2, ts: 102, op: 'put' as const, queueId: 1, threadId: 1, ok: true },
      ],
      rewind.nextIndex,
    )
    expect(after.kind).toBe('delta')
    expect(after.newest.map((e) => e.index)).toEqual([2])
  })
})

describe('sortQueuesByPipelineOrder', () => {
  it('orders queues by longest-path pipeline rank, not alphabetically', () => {
    const reader = new TraceReader(fallbackDefs())
    const producer = 0x1000
    const filter = 0x1001
    const sink = 0x1002
    const inputQ = 0x2001
    const workQ = 0x2002
    const doneQ = 0x2003
    // producer → input_q → filter → work_q → sink → done_q
    // Pair switched_out / switched_in like real Zephyr CTF so only one thread
    // is marked running at a time (threadRunningAt walks run-state).
    reader.feed(
      Uint8Array.from([
        ...record(10, 0x11, [...encU32(producer), ...encName('producer')]),
        ...record(20, 0x8c, [...encU32(inputQ), ...encU32(0), ...encI32(0)]),
        ...record(25, 0x10, [...encU32(producer), ...encName('producer')]),
        ...record(30, 0x11, [...encU32(filter), ...encName('filter')]),
        ...record(40, 0x8f, [...encU32(inputQ), ...encU32(0), ...encI32(0)]),
        ...record(50, 0x8c, [...encU32(workQ), ...encU32(0), ...encI32(0)]),
        ...record(55, 0x10, [...encU32(filter), ...encName('filter')]),
        ...record(60, 0x11, [...encU32(sink), ...encName('sink')]),
        ...record(70, 0x8f, [...encU32(workQ), ...encU32(0), ...encI32(0)]),
        ...record(80, 0x8c, [...encU32(doneQ), ...encU32(0), ...encI32(0)]),
      ]),
    )
    // Deliberately alphabetical input order (done, input, work).
    const sorted = sortQueuesByPipelineOrder(reader.tr, [
      { id: doneQ, name: 'done_q' },
      { id: inputQ, name: 'input_q' },
      { id: workQ, name: 'work_q' },
    ])
    expect(sorted.map((q) => q.name)).toEqual(['input_q', 'work_q', 'done_q'])
  })
})
