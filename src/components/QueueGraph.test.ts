import { describe, expect, it } from 'vitest'
import { legendItems } from './QueueGraph'
import { buildSemanticGraph, type FlowNodeSpec, type FlowSpec } from './queueGraph/model'

const nodes: FlowNodeSpec[] = [
  { id: 'agg', kind: 'thread', label: 'aggregator' },
  { id: 'storage', kind: 'thread', label: 'storage' },
  { id: 'isr', kind: 'isr', label: '[ISR]' },
  { id: 'q', kind: 'msgq', label: 'sensor_q', depth: 0, capacity: 16 },
  { id: 'bus', kind: 'mutex', label: 'bus_mutex' },
  { id: 'tick', kind: 'sem', label: 'tick_sem' },
]

/** The legend of a graph of `flows` and the nodes they join. */
function legend(flows: FlowSpec[]): string[] {
  const used = new Set(flows.flatMap((flow) => [flow.actorId, flow.objectId]))
  const graph = buildSemanticGraph(
    nodes.filter((node) => used.has(node.id)),
    flows,
  )
  return legendItems(graph).map((item) => item.label)
}

describe('legendItems', () => {
  it('keeps holds and waits for as long as a mutex is locked along a route', () => {
    // Whether bus_mutex is held or waited on at the latest event changes with
    // every lock; the legend does not.
    expect(
      legend([
        { id: 'agg-bus', actorId: 'agg', objectId: 'bus', action: 'lock', side: 'in' },
        { id: 'storage-bus', actorId: 'storage', objectId: 'bus', action: 'lock', side: 'out' },
      ]),
    ).toEqual(['lock', 'holds', 'waits', 'thread', 'mutex'])
  })

  it('lists waits but not holds for a semaphore that is taken', () => {
    expect(
      legend([
        { id: 'isr-tick', actorId: 'isr', objectId: 'tick', action: 'give' },
        { id: 'agg-tick', actorId: 'agg', objectId: 'tick', action: 'take' },
      ]),
    ).toEqual(['give', 'take', 'waits', 'thread', 'ISR', 'semaphore'])
  })

  it('lists neither for queues, or for a semaphore only given', () => {
    expect(
      legend([
        { id: 'isr-q', actorId: 'isr', objectId: 'q', action: 'put' },
        { id: 'agg-q', actorId: 'agg', objectId: 'q', action: 'get' },
        { id: 'isr-tick', actorId: 'isr', objectId: 'tick', action: 'give' },
      ]),
    ).toEqual(['put / give', 'get', 'thread', 'ISR', 'semaphore'])
  })
})
