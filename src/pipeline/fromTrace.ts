/**
 * Derive a live pipeline snapshot from the CTF Trace at the live edge.
 *
 * Thread state colours the nodes; recent named_event markers flash nodes and
 * heat edges; blocking reasons light the sync-object they wait on.
 */

import { stateAt, threadRunningAt, type Trace } from '@/ctf'
import type { ThreadState } from '@/ctf'
import {
  NODE_BY_THREAD,
  PIPELINE_EDGES,
  PIPELINE_NODES,
  SENSOR_BY_ARG0,
  type PipelineEdgeId,
  type PipelineNodeId,
} from './topology'

/** Guest-time window for "just happened" flashes (~one sensor period). */
export const HOT_NS = 80_000_000 // 80 ms

export interface PipelineNodeLive {
  id: PipelineNodeId
  tid: number | null
  state: ThreadState | null
  reason: string
  /** Named-event activity in the last {@link HOT_NS}. */
  flash: boolean
  label: string
  prio: number | null
}

export interface PipelineEdgeLive {
  id: PipelineEdgeId
  label: string
  kind: 'msgq' | 'condvar' | 'mutex'
  /** Recent traffic or a thread currently blocked on this primitive. */
  hot: boolean
  /** Thread currently blocked waiting here, if any. */
  waiter: string | null
}

export interface PipelineLive {
  nodes: PipelineNodeLive[]
  edges: PipelineEdgeLive[]
  /** Latest frame_publish seq, when seen. */
  frameSeq: number | null
  frameAvg: number | null
  /** Latest flush's msgq depth (arg1), when seen. */
  msgqDepth: number | null
}

function tidByName(tr: Trace): Map<string, number> {
  const out = new Map<string, number>()
  for (const [tid, info] of tr.threads) {
    if (info.name) out.set(info.name, tid)
  }
  return out
}

function edgeFromReason(reason: string): PipelineEdgeId | null {
  const r = reason.toLowerCase()
  if (r.includes('msgq')) return 'sensor_q'
  if (r.includes('condvar')) return 'frame'
  // Bus is the sample's contested mutex/sem; agg_mutex also says "mutex" but
  // waiters on the bus are the story the diagram wants to tell.
  if (r.includes('mutex') || r.includes('sem')) return 'bus'
  return null
}

function namedTarget(
  tr: Trace,
  name: string,
  arg0: number,
  ts: number,
): { node?: PipelineNodeId; edge?: PipelineEdgeId } {
  switch (name) {
    case 'sensor_sample': {
      const byArg = SENSOR_BY_ARG0[arg0]
      const running = threadRunningAt(tr, ts)
      const runName = running != null ? tr.threads.get(running)?.name : undefined
      const byRun = runName ? NODE_BY_THREAD.get(runName) : undefined
      return { node: byRun ?? byArg, edge: 'sensor_q' }
    }
    case 'frame_publish':
      return { node: 'aggregator', edge: 'frame' }
    case 'bus_write':
      return { node: 'aggregator', edge: 'bus' }
    case 'consume_begin':
    case 'consume_end':
      return {
        node: arg0 === 1 ? 'consumer1' : 'consumer0',
        edge: 'frame',
      }
    case 'store_begin':
    case 'store_end':
      return { node: 'storage', edge: 'bus' }
    case 'flush':
      return { edge: 'sensor_q' }
    default:
      return {}
  }
}

/**
 * Live pipeline view at `ts` (defaults to the trace's right edge).
 * Pass a synthetic Trace in tests; production uses hostTrace's snapshot.
 */
export function pipelineFromTrace(tr: Trace, ts = tr.t1): PipelineLive {
  const names = tidByName(tr)
  const hotNodes = new Set<PipelineNodeId>()
  const hotEdges = new Set<PipelineEdgeId>()
  let frameSeq: number | null = null
  let frameAvg: number | null = null
  let msgqDepth: number | null = null

  // Scan newest-first so "last" metrics stick without a second pass.
  for (let i = tr.events.length - 1; i >= 0; i--) {
    const ev = tr.events[i]!
    if (ev.name !== 'named_event') continue
    const name = String(ev.fields.name ?? '')
    const arg0 = Number(ev.fields.arg0 ?? 0)
    const arg1 = Number(ev.fields.arg1 ?? 0)
    const age = ts - ev.ts

    if (name === 'frame_publish' && frameSeq === null) {
      frameSeq = arg0
      frameAvg = arg1
    }
    if (name === 'flush' && msgqDepth === null) {
      msgqDepth = arg1
    }

    if (age < 0 || age > HOT_NS) continue
    const target = namedTarget(tr, name, arg0, ev.ts)
    if (target.node) hotNodes.add(target.node)
    if (target.edge) hotEdges.add(target.edge)
  }

  const nodes: PipelineNodeLive[] = PIPELINE_NODES.map((def) => {
    const tid = names.get(def.threadName) ?? null
    const [state, reason] =
      tid != null ? stateAt(tr, tid, ts) : ([null, ''] as [ThreadState | null, string])
    return {
      id: def.id,
      tid,
      state,
      reason,
      flash: hotNodes.has(def.id),
      label: def.label,
      prio: tid != null ? (tr.threads.get(tid)?.prio ?? null) : null,
    }
  })

  const waiters = new Map<PipelineEdgeId, string>()
  for (const node of nodes) {
    if (node.state !== 'blk' || !node.reason) continue
    const edge = edgeFromReason(node.reason)
    if (!edge) continue
    hotEdges.add(edge)
    if (!waiters.has(edge)) {
      const def = PIPELINE_NODES.find((n) => n.id === node.id)
      waiters.set(edge, def?.threadName ?? node.label)
    }
  }

  const edges: PipelineEdgeLive[] = PIPELINE_EDGES.map((def) => ({
    id: def.id,
    label: def.label,
    kind: def.kind,
    hot: hotEdges.has(def.id),
    waiter: waiters.get(def.id) ?? null,
  }))

  return { nodes, edges, frameSeq, frameAvg, msgqDepth }
}
