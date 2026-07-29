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

export function buildLiveQueueGraph(tr: Trace, queues: QueueSeries[]): LiveQueueGraph {
  const queueById = new Map(queues.map((queue) => [queue.id, queue]))
  const flow = queueFlowEvents(tr)
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
