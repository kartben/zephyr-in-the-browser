import {
  flowEdgeId,
  flowThreadLabel,
  queueFlowEvents,
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

export function liveObjectNodeId(queueId: number): string {
  return `object:${queueId}`
}

export function liveEdgeId(event: Pick<QueueFlowEvent, 'threadId' | 'queueId' | 'op'>): string {
  if (event.threadId == null) throw new Error('Cannot create a live edge without a thread')
  return `flow:${flowEdgeId({
    threadId: event.threadId,
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
    (event): event is QueueFlowEvent & { threadId: number } =>
      event.ok && event.threadId != null && queueById.has(event.queueId),
  )
  const threadIds = [...new Set(valid.map((event) => event.threadId))].sort((a, b) => {
    const labelOrder = flowThreadLabel(tr, a).localeCompare(flowThreadLabel(tr, b))
    return labelOrder || a - b
  })

  const nodes: FlowNodeSpec[] = [
    ...threadIds.map((threadId): FlowNodeSpec => {
      const info = tr.threads.get(threadId)
      return {
        id: liveThreadNodeId(threadId),
        kind: 'thread',
        label: flowThreadLabel(tr, threadId),
        detail: info?.prio == null ? `tid 0x${threadId.toString(16)}` : `priority ${info.prio}`,
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
      threadId: liveThreadNodeId(event.threadId),
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
