import { describe, expect, it } from 'vitest'
import type { QueueSeries, Trace } from '@/ctf'
import {
  buildLiveQueueGraph,
  liveFlowAction,
  liveObjectNodeId,
  liveQueueNodeState,
  liveThreadNodeId,
} from './live'

function trace(): Trace {
  return {
    events: [
      { ts: 10, eid: 1, name: 'msgq_put_enter', fields: { id: 0x1000 } },
      { ts: 20, eid: 2, name: 'msgq_put_exit', fields: { id: 0x1000, ret: 0 } },
      { ts: 110, eid: 3, name: 'stack_push_enter', fields: { id: 0x2000 } },
      { ts: 120, eid: 4, name: 'stack_push_exit', fields: { id: 0x2000, ret: 0 } },
      { ts: 210, eid: 5, name: 'stack_pop_enter', fields: { id: 0x2000 } },
      { ts: 220, eid: 6, name: 'stack_pop_exit', fields: { id: 0x2000, ret: 0 } },
    ],
    threads: new Map([
      [1, { name: 'producer', prio: 1, stackBase: null, stackSize: null }],
      [2, { name: 'worker', prio: 3, stackBase: null, stackSize: null }],
      [3, { name: 'consumer', prio: 5, stackBase: null, stackSize: null }],
    ]),
    segments: [
      [0, 100, 1],
      [100, 200, 2],
      [200, 300, 3],
    ],
    isrSpans: [],
    isrOpenStart: null,
    states: new Map(),
    stateStarts: new Map(),
    t0: 0,
    t1: 300,
  }
}

function queues(): QueueSeries[] {
  return [
    {
      id: 0x1000,
      kind: 'msgq',
      name: 'messages',
      samples: [{ ts: 20, depth: 1 }],
      drops: 0,
      cap: 1_000_000,
      capSource: 'object-core',
      peak: 1,
    },
    {
      id: 0x2000,
      kind: 'stack',
      name: null,
      samples: [
        { ts: 120, depth: 1 },
        { ts: 220, depth: 0 },
      ],
      drops: 0,
      cap: 32,
      capSource: 'object-core',
      peak: 1,
    },
  ]
}

describe('live queue graph adapter', () => {
  it('builds semantic nodes and top-only stack routes from live CTF data', () => {
    const live = buildLiveQueueGraph(trace(), queues())

    expect(live.graph.nodes).toHaveLength(5)
    expect(live.graph.edges).toHaveLength(3)
    expect(live.graph.edges.map((edge) => edge.action)).toEqual(['put', 'push', 'pop'])

    const stack = live.graph.nodes.find((node) => node.id === liveObjectNodeId(0x2000))
    expect(stack?.ports.map((port) => port.side)).toEqual(['NORTH', 'NORTH'])
    expect(stack?.ports.map((port) => port.role)).toEqual(['top-in', 'top-out'])

    const pop = live.graph.edges.find((edge) => edge.action === 'pop')
    expect(pop?.sourceNodeId).toBe(liveObjectNodeId(0x2000))
    expect(pop?.targetNodeId).toBe(liveThreadNodeId(3))
  })

  it('keeps large capacities exact in state while mapping LIFO actions', () => {
    const state = liveQueueNodeState(trace(), queues())

    expect(state.get(liveObjectNodeId(0x1000))).toMatchObject({
      depth: 1,
      capacity: 1_000_000,
    })
    expect(liveFlowAction('lifo', 'put_front')).toBe('push')
    expect(liveFlowAction('lifo', 'get')).toBe('pop')
  })

  it('uses the supplied publication flow instead of rescanning mutable trace history', () => {
    const live = buildLiveQueueGraph(trace(), queues(), [])

    expect(live.flow).toEqual([])
    expect(live.graph.edges).toEqual([])
  })
})
