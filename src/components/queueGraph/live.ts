import {
  flowEdgeId,
  flowThreadLabel,
  queueActorKey,
  queueActorLabel,
  queueFlowEvents,
  type QueueActor,
  type QueueFlowEvent,
  type QueueFlowOp,
} from '@/ctf/queueGraph'
import { queueLabel, type QueueSeries, type Trace } from '@/ctf'
import { buildSemanticGraph, type FlowAction, type FlowNodeSpec, type FlowSpec } from './model'
import type { QueueGraphNodeState } from './QueueGraphCanvas'

export interface LiveQueueGraph {
  graph: ReturnType<typeof buildSemanticGraph>
  flow: QueueFlowEvent[]
  topologyKey: string
}

export interface QueueDepthEnvelope {
  minDepth: number
  maxDepth: number
  finalDepth: number
}

export function liveThreadNodeId(threadId: number): string {
  return `thread:${threadId}`
}

export const LIVE_ISR_NODE_ID = 'actor:isr'

export function liveActorNodeId(actor: Exclude<QueueActor, { kind: 'unknown' }>): string {
  return actor.kind === 'thread' ? liveThreadNodeId(actor.threadId) : LIVE_ISR_NODE_ID
}

export function liveObjectNodeId(queueId: number): string {
  return `object:${queueId}`
}

export function liveEdgeId(event: Pick<QueueFlowEvent, 'actor' | 'queueId' | 'op'>): string {
  if (event.actor.kind === 'unknown') throw new Error('Cannot create a live edge without an actor')
  return `flow:${flowEdgeId({
    actorKey: queueActorKey(event.actor),
    queueId: event.queueId,
    op: event.op,
  })}`
}

export function liveFlowAction(kind: QueueSeries['kind'], op: QueueFlowOp): FlowAction {
  if (kind === 'stack' || kind === 'lifo') {
    return op === 'get' ? 'pop' : 'push'
  }
  if (op === 'put_front') return 'put-front'
  return op
}

function currentDepth(queue: QueueSeries): number {
  return queue.samples.at(-1)?.depth ?? 0
}

/**
 * Compress all depth changes since the previous publication into an exact
 * min/max envelope. The node can remain truthful about its final depth while
 * still surfacing a fill-and-drain spike that happened inside the batch.
 */
export function queueDepthEnvelope(
  queue: QueueSeries,
  afterTs: number,
  previousDepth: number,
): QueueDepthEnvelope | null {
  let minDepth = previousDepth
  let maxDepth = previousDepth
  let cursor = previousDepth
  let changed = false
  // Samples are chronological; jump straight to this publication's suffix so
  // a long-running trace does not rescan the queue's entire depth history.
  let lo = 0
  let hi = queue.samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (queue.samples[mid]!.ts <= afterTs) lo = mid + 1
    else hi = mid
  }
  for (let i = lo; i < queue.samples.length; i++) {
    const sample = queue.samples[i]!
    if (sample.depth !== cursor) changed = true
    cursor = sample.depth
    minDepth = Math.min(minDepth, sample.depth)
    maxDepth = Math.max(maxDepth, sample.depth)
  }
  if (!changed) return null
  return { minDepth, maxDepth, finalDepth: currentDepth(queue) }
}

function fixedCapacity(queue: QueueSeries): number | null {
  return queue.kind === 'msgq' || queue.kind === 'stack' ? queue.cap : null
}

export function liveQueueNodeState(
  tr: Trace,
  queues: QueueSeries[],
): Map<string, QueueGraphNodeState> {
  const state = new Map<string, QueueGraphNodeState>()
  for (const queue of queues) {
    state.set(liveObjectNodeId(queue.id), {
      label: queueLabel(queue),
      depth: currentDepth(queue),
      capacity: fixedCapacity(queue),
    })
  }
  for (const [threadId, info] of tr.threads) {
    state.set(liveThreadNodeId(threadId), {
      label: flowThreadLabel(tr, threadId),
      detail: info.prio == null ? `tid 0x${threadId.toString(16)}` : `priority ${info.prio}`,
    })
  }
  state.set(LIVE_ISR_NODE_ID, {
    label: '[ISR]',
    detail: 'interrupt context',
  })
  return state
}

export function buildLiveQueueGraph(
  tr: Trace,
  queues: QueueSeries[],
  flowEvents?: QueueFlowEvent[],
): LiveQueueGraph {
  const queueById = new Map(queues.map((queue) => [queue.id, queue]))
  const flow = flowEvents ?? queueFlowEvents(tr)
  const valid = flow.filter(
    (
      event,
    ): event is QueueFlowEvent & {
      actor: Exclude<QueueActor, { kind: 'unknown' }>
    } => event.ok && event.actor.kind !== 'unknown' && queueById.has(event.queueId),
  )
  const actors = new Map<
    string,
    {
      actor: Exclude<QueueActor, { kind: 'unknown' }>
      label: string
    }
  >()
  for (const event of valid) {
    const key = queueActorKey(event.actor)
    actors.set(key, { actor: event.actor, label: queueActorLabel(tr, event.actor) })
  }
  const actorSpecs = [...actors.values()].sort((a, b) => a.label.localeCompare(b.label))

  const nodes: FlowNodeSpec[] = [
    ...actorSpecs.map(({ actor, label }): FlowNodeSpec => {
      const info = actor.kind === 'thread' ? tr.threads.get(actor.threadId) : null
      return {
        id: liveActorNodeId(actor),
        kind: actor.kind,
        label,
        detail:
          actor.kind === 'isr'
            ? 'interrupt context'
            : info?.prio == null
              ? `tid 0x${actor.threadId.toString(16)}`
              : `priority ${info.prio}`,
      }
    }),
    ...queues.map(
      (queue): FlowNodeSpec => ({
        id: liveObjectNodeId(queue.id),
        kind: queue.kind,
        label: queueLabel(queue),
        depth: currentDepth(queue),
        capacity: fixedCapacity(queue),
      }),
    ),
  ]

  const seen = new Set<string>()
  const flows: FlowSpec[] = []
  for (const event of valid) {
    const id = liveEdgeId(event)
    if (seen.has(id)) continue
    seen.add(id)
    const queue = queueById.get(event.queueId)!
    flows.push({
      id,
      actorId: liveActorNodeId(event.actor),
      objectId: liveObjectNodeId(event.queueId),
      action: liveFlowAction(queue.kind, event.op),
    })
  }

  const graph = buildSemanticGraph(nodes, flows)
  const topologyKey = [
    ...graph.nodes.map((node) => `${node.id}:${node.kind}`),
    ...graph.edges.map(
      (edge) => `${edge.id}:${edge.sourceNodeId}:${edge.targetNodeId}:${edge.action}`,
    ),
  ].join('|')
  return { graph, flow, topologyKey }
}
