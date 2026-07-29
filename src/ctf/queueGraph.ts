/**
 * Derive thread↔queue put/get/put_front flow from CTF exits.
 *
 * Exit events do not carry a thread id — the running thread at `ts`
 * (from the Schedule reconstruction) is the actor.
 *
 * Mouth mapping (unified across msgq / fifo / lifo / k_queue):
 *   - put        → end   (append / msgq put / fifo put)
 *   - put_front  → front (prepend / msgq put_front / lifo put)
 *   - get        → front (FIFO/LIFO/msgq/queue get from the head)
 *
 * Nested queue_* under fifo/lifo ids are suppressed — same policy as depth.
 */

import {
  classifyQueueEnter,
  classifyQueueEvent,
  classifyQueueKinds,
  isNestedQueueEvent,
  type QueueFlowOp,
} from './queueKinds'
import { isrActiveAt, scheduledThreadAt, threadLabel, type Trace } from './reader'

export type { QueueFlowOp }

/** Depth-chart ops: flow exits plus purge (empties the ring). */
export type QueueChartOp = QueueFlowOp | 'purge'

/** Confirmed execution context for a queue operation. */
export type QueueActor =
  | { kind: 'thread'; threadId: number }
  | { kind: 'isr' }
  | { kind: 'unknown' }

/** Which end of the pipe an op touches. */
export type MsgqMouth = 'end' | 'front'

export function isPutOp(op: QueueFlowOp): boolean {
  return op === 'put' || op === 'put_front'
}

/**
 * put writes the end; put_front and get use the front/head.
 */
export function mouthForOp(op: QueueFlowOp): MsgqMouth {
  return op === 'put' ? 'end' : 'front'
}

export interface QueueFlowEvent {
  /** Index into tr.events — stable identity for “what’s new”. */
  index: number
  /**
   * Mark timestamp: matching put/get *enter* when present, else a concurrent
   * waiter `sched_ready`, else exit. Zephyr wakes waiters inside put/get
   * *before* the exit tracepoint, so exit-only marks look causality-inverted.
   */
  ts: number
  /** Exit timestamp (ret / depth clock). */
  exitTs?: number
  op: QueueFlowOp
  queueId: number
  /** Explicit execution context; distinguishes confirmed ISR from trace loss. */
  actor: QueueActor
  /** Thread actor id retained for thread-oriented consumers, otherwise null. */
  threadId: number | null
  ok: boolean
}

/**
 * Timestamp where the operation takes effect in queue/depth visualizations.
 *
 * `ts` may intentionally point back to a much earlier blocking enter for
 * scheduler causality. The exit is where the operation completes and where
 * reconstructed depth changes are sampled.
 */
export function queueFlowEffectTs(
  event: Pick<QueueFlowEvent, 'ts' | 'exitTs'>,
): number {
  return event.exitTs ?? event.ts
}

/** Queue event surfaced on the depth-chart hover tip (includes purge). */
export interface QueueChartEvent {
  index: number
  ts: number
  op: QueueChartOp
  queueId: number
  actor: QueueActor
  threadId: number | null
  ok: boolean
}

function enterKey(op: QueueFlowOp, queueId: number): string {
  return `${op}|${queueId}`
}

/** Lookback when falling back from exit to a concurrent waiter ready. */
const WAKE_LOOKBACK_NS = 1_000_000 // 1 ms

type EnterMark = { ts: number; actor: QueueActor }

/**
 * Resolve execution context in record order, not from timestamps alone.
 *
 * Multiple CTF records can share one clock tick. In particular, a queue exit
 * immediately followed by isr_exit may have the same timestamp. A half-open
 * time-span lookup would call the queue exit post-ISR even though its record
 * precedes the exit boundary.
 */
function queueActorsByEvent(tr: Trace): Map<number, QueueActor> {
  const first = tr.events[0]
  const startedBeforeFirst =
    first != null &&
    (tr.isrSpans.some(([start, end]) => start < first.ts && first.ts < end) ||
      (tr.isrOpenStart != null && tr.isrOpenStart < first.ts))
  let isrDepth =
    first != null &&
    (startedBeforeFirst || (first.name !== 'isr_enter' && isrActiveAt(tr, first.ts)))
      ? 1
      : 0
  const actors = new Map<number, QueueActor>()

  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    if (
      isrDepth > 0 &&
      (ev.name === 'thread_switched_in' || ev.name === 'thread_switched_out')
    ) {
      // Same conservative recovery as TraceReader when an ISR exit was lost.
      isrDepth = 0
    }
    if (ev.name === 'isr_enter') isrDepth++

    if (/^(msgq|fifo|lifo|stack|queue)_/.test(ev.name)) {
      const threadId = isrDepth > 0 ? null : scheduledThreadAt(tr, ev.ts)
      actors.set(
        i,
        isrDepth > 0
          ? { kind: 'isr' }
          : threadId == null
            ? { kind: 'unknown' }
            : { kind: 'thread', threadId },
      )
    }

    if (
      isrDepth > 0 &&
      (ev.name === 'isr_exit' || ev.name === 'isr_exit_to_scheduler')
    ) {
      isrDepth--
    }
  }
  return actors
}

export function queueActorKey(actor: QueueActor): string {
  if (actor.kind === 'thread') return `thread:${actor.threadId}`
  return actor.kind
}

export function queueActorLabel(tr: Trace, actor: QueueActor): string {
  if (actor.kind === 'thread') return threadLabel(tr, actor.threadId)
  if (actor.kind === 'isr') return '[ISR]'
  return '?'
}

/** All successful/failed put / put_front / get exits in timestamp order. */
export function queueFlowEvents(tr: Trace): QueueFlowEvent[] {
  const kinds = classifyQueueKinds(tr.events)
  const actors = queueActorsByEvent(tr)
  const out: QueueFlowEvent[] = []
  /** Unmatched enter marks per op|queue (stack — single-CPU nest-safe). */
  const enters = new Map<string, EnterMark[]>()
  /** Latest waiter ready in the open window (for exit-only fallback). */
  let lastWakeTs: number | null = null
  let lastWakeTid: number | null = null

  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!

    if (ev.name === 'thread_sched_ready' || ev.name === 'thread_ready') {
      const tid = ev.fields.thread_id
      if (typeof tid === 'number') {
        lastWakeTs = ev.ts
        lastWakeTid = tid
      }
      continue
    }

    const enter = classifyQueueEnter(ev.name, ev.fields)
    if (enter) {
      if (isNestedQueueEvent(enter, kinds)) continue
      const key = enterKey(enter.flowOp, enter.id)
      const stack = enters.get(key) ?? []
      // Record who was running at enter — used later to reject stale pairs
      // (e.g. main's leftover enter claimed by a worker's exit).
      stack.push({ ts: ev.ts, actor: actors.get(i)! })
      enters.set(key, stack)
      continue
    }

    const classified = classifyQueueEvent(ev.name, ev.fields)
    if (!classified || !classified.flowOp) continue
    if (isNestedQueueEvent(classified, kinds)) continue

    const stack = enters.get(enterKey(classified.flowOp, classified.id))
    const enterMark = stack?.length ? stack.pop()! : null
    const exitTs = ev.ts
    // Actor is always who ran the exit (the thread that called put/get).
    // Mark X may snap back to enter/wake for causality; never reattribute.
    const actorAtExit = actors.get(i)!
    const threadAtExit = actorAtExit.kind === 'thread' ? actorAtExit.threadId : null
    let ts = exitTs
    if (
      enterMark != null &&
      (enterMark.actor.kind === 'unknown' ||
        actorAtExit.kind === 'unknown' ||
        queueActorKey(enterMark.actor) === queueActorKey(actorAtExit))
    ) {
      ts = enterMark.ts
    } else if (
      enterMark == null &&
      lastWakeTs != null &&
      lastWakeTid != null &&
      lastWakeTid !== threadAtExit &&
      lastWakeTs <= exitTs &&
      exitTs - lastWakeTs <= WAKE_LOOKBACK_NS
    ) {
      // No enter in the stream: snap the mark back to the wake so ready does
      // not appear *before* the put/get edge.
      ts = lastWakeTs
    }

    out.push({
      index: i,
      ts,
      exitTs,
      op: classified.flowOp,
      queueId: classified.id,
      actor: actorAtExit,
      threadId: threadAtExit,
      ok: classified.ok,
    })
  }
  return out
}

/**
 * Advance a “last seen event index” cursor over {@link queueFlowEvents}.
 *
 * `index` is the offset into the *current* `tr.events` array. When hostTrace
 * trims the ring (`MAX_EVENTS`), those indices restart near 0 — a stale high
 * watermark would then never see `index > last` again and pipe packets stall.
 * Detect that rewind and skip retained history instead of replaying it.
 */
export function advanceFlowCursor(
  flow: QueueFlowEvent[],
  lastIndex: number,
): {
  kind: 'first' | 'trimmed' | 'delta'
  newest: QueueFlowEvent[]
  nextIndex: number
} {
  const tip = flow.length ? flow[flow.length - 1]!.index : -1
  if (lastIndex < 0) {
    return { kind: 'first', newest: [], nextIndex: tip }
  }
  if (tip < lastIndex) {
    return { kind: 'trimmed', newest: [], nextIndex: tip }
  }
  return {
    kind: 'delta',
    newest: flow.filter((ev) => ev.index > lastIndex),
    nextIndex: tip,
  }
}

/**
 * Put / put_front / get / purge exits for the depth chart — same attribution
 * as {@link queueFlowEvents}, plus purge (no flow mouth; always ok).
 */
export function queueChartEvents(tr: Trace): QueueChartEvent[] {
  const kinds = classifyQueueKinds(tr.events)
  const actors = queueActorsByEvent(tr)
  const out: QueueChartEvent[] = []
  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    const classified = classifyQueueEvent(ev.name, ev.fields)
    if (!classified) continue
    if (isNestedQueueEvent(classified, kinds)) continue
    // queue_remove is depth-only (get without a flow mouth) — still tip as get.
    const chartOp: QueueChartOp =
      classified.flowOp ?? (classified.depthAction === 'purge' ? 'purge' : classified.depthAction)
    const actor = actors.get(i)!
    out.push({
      index: i,
      ts: ev.ts,
      op: chartOp,
      queueId: classified.id,
      actor,
      threadId: actor.kind === 'thread' ? actor.threadId : null,
      ok: classified.ok,
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
      return 'put'
    case 'put_front':
      return 'put_front'
    case 'get':
      return 'get'
    case 'purge':
      return 'purge'
  }
}

/** Timeline / graph stroke colors for queue ops (failed → soft red). */
export function msgqOpColor(op: QueueFlowOp | QueueChartOp, ok = true): string {
  if (!ok) return 'rgba(248, 113, 113, 0.95)'
  // Bright on dark thread bars; distinct from ready yellow / sleep cyan.
  if (op === 'put_front') return '#f9a8d4'
  if (op === 'put') return '#7dd3fc'
  if (op === 'purge') return 'rgba(244, 63, 94, 0.85)'
  return '#fdba74'
}

export interface FlowEdgeKey {
  actorKey: string
  queueId: number
  op: QueueFlowOp
}

export function flowEdgeId(e: FlowEdgeKey): string {
  return `${e.actorKey}|${e.queueId}|${e.op}`
}

/** Put/get counts per thread for bipartite left/right placement. put_front counts as put. */
export function threadFlowScores(events: QueueFlowEvent[]): Map<number, number> {
  const score = new Map<number, number>()
  for (const ev of events) {
    if (ev.actor.kind !== 'thread' || !ev.ok) continue
    const delta = isPutOp(ev.op) ? 1 : -1
    score.set(ev.actor.threadId, (score.get(ev.actor.threadId) ?? 0) + delta)
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
  const valid = flow.filter((ev) => ev.ok && ev.actor.kind !== 'unknown' && ranks.has(ev.queueId))
  const actorIds = [...new Set(valid.map((ev) => queueActorKey(ev.actor)))]

  const nodeIds = [...actorIds.map((id) => `a:${id}`), ...qids.map((id) => `q:${id}`)]
  const outgoing = new Map(nodeIds.map((id) => [id, new Set<string>()]))
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  const seen = new Set<string>()
  for (const ev of valid) {
    const actorId = `a:${queueActorKey(ev.actor)}`
    const edge = `${actorId}|${ev.queueId}|${ev.op}`
    if (seen.has(edge)) continue
    seen.add(edge)
    const from = ev.op === 'get' ? `q:${ev.queueId}` : actorId
    const to = ev.op === 'get' ? actorId : `q:${ev.queueId}`
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
