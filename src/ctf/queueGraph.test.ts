import { describe, expect, it } from 'vitest'
import { fallbackDefs } from './metadata'
import { TraceReader } from './reader'
import { isPutOp, queueFlowEvents, threadFlowScores } from './queueGraph'

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
})
