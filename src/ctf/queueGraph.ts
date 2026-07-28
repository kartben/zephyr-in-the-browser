/**
 * Derive thread↔msgq put/get flow from CTF exits.
 *
 * Msgq exit events do not carry a thread id — the running thread at `ts`
 * (from the Schedule reconstruction) is the actor.
 */

import {
  MSGQ_GET_EXIT,
  MSGQ_PUT_EXIT,
  MSGQ_PUT_FRONT_EXIT,
} from './types'
import { threadLabel, threadRunningAt, type Trace } from './reader'

export type QueueFlowOp = 'put' | 'get'

export interface QueueFlowEvent {
  /** Index into tr.events — stable identity for “what’s new”. */
  index: number
  ts: number
  op: QueueFlowOp
  queueId: number
  /** Running thread at ts, or null if unknown / ISR. */
  threadId: number | null
  ok: boolean
}

const PUT_EXITS = new Set([MSGQ_PUT_EXIT, MSGQ_PUT_FRONT_EXIT])

/** All successful/failed put/get exits in timestamp order. */
export function queueFlowEvents(tr: Trace): QueueFlowEvent[] {
  const out: QueueFlowEvent[] = []
  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    const eid = ev.eid
    let op: QueueFlowOp | null = null
    if (PUT_EXITS.has(eid)) op = 'put'
    else if (eid === MSGQ_GET_EXIT) op = 'get'
    if (!op) continue
    const queueId = ev.fields.id
    if (typeof queueId !== 'number') continue
    const ret = typeof ev.fields.ret === 'number' ? ev.fields.ret : 0
    out.push({
      index: i,
      ts: ev.ts,
      op,
      queueId,
      threadId: threadRunningAt(tr, ev.ts),
      ok: ret === 0,
    })
  }
  return out
}

export interface FlowEdgeKey {
  threadId: number
  queueId: number
  op: QueueFlowOp
}

export function flowEdgeId(e: FlowEdgeKey): string {
  return `${e.threadId}|${e.queueId}|${e.op}`
}

/** Put/get counts per thread for bipartite left/right placement. */
export function threadFlowScores(events: QueueFlowEvent[]): Map<number, number> {
  const score = new Map<number, number>()
  for (const ev of events) {
    if (ev.threadId == null || !ev.ok) continue
    const delta = ev.op === 'put' ? 1 : -1
    score.set(ev.threadId, (score.get(ev.threadId) ?? 0) + delta)
  }
  return score
}

export function flowThreadLabel(tr: Trace, tid: number): string {
  return threadLabel(tr, tid)
}
