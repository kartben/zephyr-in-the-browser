import { describe, expect, it } from 'vitest'
import { emptyCpuPower } from '@/ctf'
import type { QueueSeries, Trace } from '@/ctf'
import { reconstructSync } from '@/ctf/syncObjects'
import { NO_IPC_FILTER } from '@/lib/ipcUi'
import {
  buildLiveQueueGraph,
  LIVE_ISR_NODE_ID,
  liveFlowAction,
  liveObjectNodeId,
  liveQueueNodeState,
  liveSyncEdgeId,
  liveSyncNodeId,
  liveSyncView,
  liveThreadNodeId,
  queueDepthEnvelope,
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
    cpuPower: emptyCpuPower(),
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
      handoffs: [],
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
      handoffs: [],
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

  it('includes ISR queue operations as a virtual synoptic actor', () => {
    const tr = trace()
    tr.events.push(
      { ts: 310, eid: 7, name: 'isr_enter', fields: {} },
      { ts: 320, eid: 8, name: 'msgq_put_enter', fields: { id: 0x1000 } },
      { ts: 340, eid: 9, name: 'msgq_put_exit', fields: { id: 0x1000, ret: 0 } },
      { ts: 340, eid: 10, name: 'isr_exit', fields: {} },
    )
    tr.isrSpans = [[310, 340]]
    tr.t1 = 340

    const live = buildLiveQueueGraph(tr, queues())
    const isr = live.graph.nodes.find((node) => node.id === LIVE_ISR_NODE_ID)
    const isrPut = live.graph.edges.find((edge) => edge.sourceNodeId === LIVE_ISR_NODE_ID)

    expect(isr).toMatchObject({
      kind: 'isr',
      label: '[ISR]',
      detail: 'interrupt context',
    })
    expect(isrPut).toMatchObject({
      targetNodeId: liveObjectNodeId(0x1000),
      action: 'put',
    })
  })

  it('lays out only what the filter keeps, and still counts everything', () => {
    const all = buildLiveQueueGraph(trace(), queues())
    const focused = buildLiveQueueGraph(trace(), queues(), undefined, {
      ...NO_IPC_FILTER,
      focus: liveObjectNodeId(0x2000),
    })

    expect(focused.focused).toBe(true)
    expect(focused.graph.nodes.map((node) => node.label)).toEqual(['consumer', 'worker', '0x2000'])
    expect(focused.graph.edges.map((edge) => edge.action)).toEqual(['push', 'pop'])
    expect(focused.nodes).toEqual(all.nodes)
    expect(focused.flows).toEqual(all.flows)
    // A different picture is a different layout.
    expect(focused.topologyKey).not.toBe(all.topologyKey)
  })

  it('uses the supplied publication flow instead of rescanning mutable trace history', () => {
    const live = buildLiveQueueGraph(trace(), queues(), [])

    expect(live.flow).toEqual([])
    expect(live.graph.edges).toEqual([])
  })

  it('squashes a fill-and-drain burst into an occupancy envelope', () => {
    const queue = queues()[0]!
    queue.samples = [
      { ts: 100, depth: 0 },
      { ts: 120, depth: 4 },
      { ts: 140, depth: 16 },
      { ts: 160, depth: 7 },
      { ts: 180, depth: 0 },
    ]

    expect(queueDepthEnvelope(queue, 100, 0)).toEqual({
      minDepth: 0,
      maxDepth: 16,
      finalDepth: 0,
    })
  })

  it('does not invent an envelope when the batch only holds its depth', () => {
    const queue = queues()[0]!
    queue.samples = [
      { ts: 100, depth: 3 },
      { ts: 200, depth: 3 },
    ]

    expect(queueDepthEnvelope(queue, 100, 3)).toBeNull()
  })

  describe('with semaphores, mutexes and condvars', () => {
    const AGG = 0x10
    const STORAGE = 0x20
    const BUS = 0x5000
    const AGG_MUTEX = 0x6000

    /** Storage holds the bus; the aggregator waits for it and lends storage its priority. */
    function busTrace(): Trace {
      const tr = trace()
      tr.threads = new Map([
        [AGG, { name: 'aggregator', prio: 3, stackBase: null, stackSize: null }],
        [STORAGE, { name: 'storage', prio: 3, stackBase: null, stackSize: null }],
      ])
      tr.events = [
        { ts: 1, eid: 0, name: 'thread_switched_in', fields: { thread_id: AGG } },
        { ts: 2, eid: 1, name: 'mutex_lock_enter', fields: { id: AGG_MUTEX } },
        { ts: 3, eid: 2, name: 'mutex_lock_exit', fields: { id: AGG_MUTEX, ret: 0 } },
        { ts: 4, eid: 3, name: 'thread_switched_out', fields: { thread_id: AGG } },
        { ts: 4, eid: 4, name: 'thread_switched_in', fields: { thread_id: STORAGE } },
        { ts: 5, eid: 5, name: 'thread_sched_priority_set', fields: { thread_id: STORAGE, prio: 9 } },
        { ts: 6, eid: 6, name: 'mutex_lock_enter', fields: { id: BUS } },
        { ts: 7, eid: 7, name: 'mutex_lock_exit', fields: { id: BUS, ret: 0 } },
        { ts: 8, eid: 8, name: 'thread_switched_out', fields: { thread_id: STORAGE } },
        { ts: 8, eid: 9, name: 'thread_switched_in', fields: { thread_id: AGG } },
        { ts: 9, eid: 10, name: 'mutex_lock_enter', fields: { id: BUS } },
        { ts: 10, eid: 11, name: 'mutex_lock_blocking', fields: { id: BUS } },
        { ts: 11, eid: 12, name: 'thread_sched_priority_set', fields: { thread_id: STORAGE, prio: 3 } },
      ]
      return tr
    }
    const names = new Map([
      [BUS, 'bus_mutex'],
      [AGG_MUTEX, 'agg_mutex'],
    ])
    const lockEdge = (threadId: number, objectId: number) =>
      liveSyncEdgeId({ kind: 'mutex', objectId, actor: { kind: 'thread', threadId }, op: 'lock' })

    it('adds the objects and their routes, and hides what one thread alone uses', () => {
      const tr = busTrace()
      const live = buildLiveQueueGraph(tr, [], [], NO_IPC_FILTER, {
        state: reconstructSync(tr),
        names,
      })
      expect(live.nodes.map((node) => node.label)).toEqual([
        'aggregator',
        'storage',
        'agg_mutex',
        'bus_mutex',
      ])
      expect(live.graph.nodes.map((node) => node.id)).toEqual([
        liveThreadNodeId(AGG),
        liveThreadNodeId(STORAGE),
        liveSyncNodeId('mutex', BUS),
      ])
      expect(live.privateCount).toBe(1)
      expect(live.graph.edges.map((edge) => edge.id)).toEqual([
        lockEdge(STORAGE, BUS),
        lockEdge(AGG, BUS),
      ])
      expect(live.flows.every((flow) => flow.side === 'in')).toBe(true)
    })

    it('shows who holds the bus, who waits for it, and the priority lent', () => {
      const tr = busTrace()
      const view = liveSyncView(tr, { state: reconstructSync(tr), names })
      expect(view.nodeState.get(liveSyncNodeId('mutex', BUS))).toMatchObject({
        label: 'bus_mutex',
        owner: 'storage',
        lockDepth: 1,
        waiterLabels: ['aggregator'],
        mutexLabel: null,
      })
      expect(view.nodeState.get(liveSyncNodeId('mutex', AGG_MUTEX))).toMatchObject({
        owner: 'aggregator',
        waiterLabels: [],
      })
      expect(view.edgeState.get(lockEdge(STORAGE, BUS))).toBe('holds')
      expect(view.edgeState.get(lockEdge(AGG, BUS))).toBe('waits')
      expect(view.edgeState.get(lockEdge(AGG, AGG_MUTEX))).toBe('holds')
      expect(view.nodeState.get(liveThreadNodeId(STORAGE))).toEqual({
        detail: 'priority 3 (inherited, base 9)',
      })
      expect(view.nodeState.has(liveThreadNodeId(AGG))).toBe(false)
    })
  })
})
