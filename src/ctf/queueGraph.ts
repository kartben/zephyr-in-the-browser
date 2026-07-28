/**
 * Derive thread↔msgq put/get/put_front flow from CTF exits.
 *
 * Msgq exit events do not carry a thread id — the running thread at `ts`
 * (from the Schedule reconstruction) is the actor.
 *
 * Mouth mapping mirrors the Zephyr msgq ring-buffer contract
 * (k_msgq_put / k_msgq_put_front / k_msgq_get):
 *   - put        → end   (write_ptr / back of the queue)
 *   - put_front  → front (read_ptr / head — retrieved before older messages)
 *   - get        → front (FIFO read from the head)
 */

import {
  MSGQ_GET_EXIT,
  MSGQ_PURGE,
  MSGQ_PUT_EXIT,
  MSGQ_PUT_FRONT_EXIT,
} from './types'
import { threadLabel, threadRunningAt, type Trace } from './reader'

export type QueueFlowOp = 'put' | 'put_front' | 'get'

/** Depth-chart ops: flow exits plus purge (empties the ring). */
export type QueueChartOp = QueueFlowOp | 'purge'

/** Which end of the msgq ring an op touches. */
export type MsgqMouth = 'end' | 'front'

export function isPutOp(op: QueueFlowOp): boolean {
  return op === 'put' || op === 'put_front'
}

/**
 * Zephyr contract: put writes the end; put_front and get use the front/head.
 * @see https://docs.zephyrproject.org/latest/doxygen/html/group__msgq__apis.html
 */
export function mouthForOp(op: QueueFlowOp): MsgqMouth {
  return op === 'put' ? 'end' : 'front'
}

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

/** Msgq event surfaced on the depth-chart hover tip (includes purge). */
export interface QueueChartEvent {
  index: number
  ts: number
  op: QueueChartOp
  queueId: number
  threadId: number | null
  ok: boolean
}

/** All successful/failed put / put_front / get exits in timestamp order. */
export function queueFlowEvents(tr: Trace): QueueFlowEvent[] {
  const out: QueueFlowEvent[] = []
  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    const eid = ev.eid
    let op: QueueFlowOp | null = null
    if (eid === MSGQ_PUT_EXIT) op = 'put'
    else if (eid === MSGQ_PUT_FRONT_EXIT) op = 'put_front'
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

/**
 * Put / put_front / get / purge exits for the depth chart — same attribution
 * as {@link queueFlowEvents}, plus purge (no ret; always ok).
 */
export function queueChartEvents(tr: Trace): QueueChartEvent[] {
  const out: QueueChartEvent[] = []
  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    const eid = ev.eid
    let op: QueueChartOp | null = null
    if (eid === MSGQ_PUT_EXIT) op = 'put'
    else if (eid === MSGQ_PUT_FRONT_EXIT) op = 'put_front'
    else if (eid === MSGQ_GET_EXIT) op = 'get'
    else if (eid === MSGQ_PURGE) op = 'purge'
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
      ok: op === 'purge' ? true : ret === 0,
    })
  }
  return out
}

/**
 * Nearest chart event for `queueId` within `maxDeltaNs` of `ts`.
 * Events are assumed sorted by timestamp (as produced by {@link queueChartEvents}).
 */
export function nearestQueueChartEvent(
  events: QueueChartEvent[],
  queueId: number,
  ts: number,
  maxDeltaNs: number,
): QueueChartEvent | null {
  if (events.length === 0 || maxDeltaNs < 0) return null
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid]!.ts < ts) lo = mid + 1
    else hi = mid
  }
  let best: QueueChartEvent | null = null
  let bestDelta = maxDeltaNs
  for (let i = lo; i < events.length; i++) {
    const ev = events[i]!
    const d = ev.ts - ts
    if (d > bestDelta) break
    if (ev.queueId !== queueId) continue
    best = ev
    bestDelta = d
  }
  for (let i = lo - 1; i >= 0; i--) {
    const ev = events[i]!
    const d = ts - ev.ts
    if (d > bestDelta) break
    if (ev.queueId !== queueId) continue
    best = ev
    bestDelta = d
  }
  return best
}

/** Short label for depth-chart / tooltip copy. */
export function queueChartOpLabel(op: QueueChartOp): string {
  switch (op) {
    case 'put':
      return 'k_msgq_put'
    case 'put_front':
      return 'k_msgq_put_front'
    case 'get':
      return 'k_msgq_get'
    case 'purge':
      return 'k_msgq_purge'
  }
}

export interface FlowEdgeKey {
  threadId: number
  queueId: number
  op: QueueFlowOp
}

export function flowEdgeId(e: FlowEdgeKey): string {
  return `${e.threadId}|${e.queueId}|${e.op}`
}

/** Put/get counts per thread for bipartite left/right placement. put_front counts as put. */
export function threadFlowScores(events: QueueFlowEvent[]): Map<number, number> {
  const score = new Map<number, number>()
  for (const ev of events) {
    if (ev.threadId == null || !ev.ok) continue
    const delta = isPutOp(ev.op) ? 1 : -1
    score.set(ev.threadId, (score.get(ev.threadId) ?? 0) + delta)
  }
  return score
}

export function flowThreadLabel(tr: Trace, tid: number): string {
  return threadLabel(tr, tid)
}

type PipelineQueue = { id: number; name?: string | null }

/**
 * Longest-path ranks on the thread↔queue flow DAG (Sugiyama layer assignment).
 * Producer→queue→consumer→queue pipelines read top-to-bottom / early-to-late.
 */
export function queuePipelineRanks(tr: Trace, queueIds: Iterable<number>): Map<number, number> {
  const qids = [...new Set(queueIds)]
  const ranks = new Map(qids.map((id) => [id, 0]))
  if (qids.length === 0) return ranks

  const flow = queueFlowEvents(tr)
  const valid = flow.filter((ev) => ev.ok && ev.threadId != null && ranks.has(ev.queueId))
  const threadIds = [...new Set(valid.map((ev) => ev.threadId!))]

  const nodeIds = [...threadIds.map((tid) => `t:${tid}`), ...qids.map((id) => `q:${id}`)]
  const outgoing = new Map(nodeIds.map((id) => [id, new Set<string>()]))
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  const seen = new Set<string>()
  for (const ev of valid) {
    const edge = `${ev.threadId}|${ev.queueId}|${ev.op}`
    if (seen.has(edge)) continue
    seen.add(edge)
    const from = ev.op === 'get' ? `q:${ev.queueId}` : `t:${ev.threadId}`
    const to = ev.op === 'get' ? `t:${ev.threadId}` : `q:${ev.queueId}`
    if (!outgoing.get(from)!.has(to)) {
      outgoing.get(from)!.add(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }

  const nodeRank = new Map(nodeIds.map((id) => [id, 0]))
  const ready = nodeIds.filter((id) => indegree.get(id) === 0)
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!
    for (const next of outgoing.get(id)!) {
      nodeRank.set(next, Math.max(nodeRank.get(next) ?? 0, (nodeRank.get(id) ?? 0) + 1))
      indegree.set(next, indegree.get(next)! - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }

  for (const id of qids) ranks.set(id, nodeRank.get(`q:${id}`) ?? 0)
  return ranks
}

/**
 * Order queues for the depth chart and topology graph: longest-path pipeline
 * rank first, then name / id. Matches the Sugiyama layering used for layout.
 */
export function sortQueuesByPipelineOrder<T extends PipelineQueue>(tr: Trace, queues: T[]): T[] {
  if (queues.length <= 1) return queues
  const ranks = queuePipelineRanks(
    tr,
    queues.map((q) => q.id),
  )
  return [...queues].sort((a, b) => {
    const ra = ranks.get(a.id) ?? 0
    const rb = ranks.get(b.id) ?? 0
    if (ra !== rb) return ra - rb
    const an = a.name ?? null
    const bn = b.name ?? null
    if (an && bn && an !== bn) return an.localeCompare(bn)
    if (an && !bn) return -1
    if (!an && bn) return 1
    return a.id - b.id
  })
}
