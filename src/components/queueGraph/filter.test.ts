import { describe, expect, it } from 'vitest'
import { NO_IPC_FILTER, type IpcFilter } from '@/lib/ipcUi'
import { filterIpcGraph, ipcKindCounts } from './filter'
import type { FlowNodeSpec, FlowSpec } from './model'

/*
 * The sensor pipeline's data path plus a side channel:
 *
 *   sensor_a, sensor_b --put--> sensor_q --get--> aggregator --put--> log_fifo --get--> logger
 *   button ISR --push--> keys (a stack nobody pops yet)
 */
const nodes: FlowNodeSpec[] = [
  { id: 'thread:1', kind: 'thread', label: 'sensor_a' },
  { id: 'thread:2', kind: 'thread', label: 'sensor_b' },
  { id: 'thread:3', kind: 'thread', label: 'aggregator' },
  { id: 'thread:4', kind: 'thread', label: 'logger' },
  { id: 'actor:isr', kind: 'isr', label: '[ISR]' },
  { id: 'object:10', kind: 'msgq', label: 'sensor_q', depth: 0, capacity: 16 },
  { id: 'object:20', kind: 'fifo', label: 'log_fifo', depth: 0, capacity: null },
  { id: 'object:30', kind: 'stack', label: 'keys', depth: 2, capacity: 8 },
  { id: 'object:40', kind: 'msgq', label: 'spare_q', depth: 0, capacity: 4 },
]

const flows: FlowSpec[] = [
  { id: 'f1', actorId: 'thread:1', objectId: 'object:10', action: 'put' },
  { id: 'f2', actorId: 'thread:2', objectId: 'object:10', action: 'put' },
  { id: 'f3', actorId: 'thread:3', objectId: 'object:10', action: 'get' },
  { id: 'f4', actorId: 'thread:3', objectId: 'object:20', action: 'put' },
  { id: 'f5', actorId: 'thread:4', objectId: 'object:20', action: 'get' },
  { id: 'f6', actorId: 'actor:isr', objectId: 'object:30', action: 'push' },
]

function run(filter: Partial<IpcFilter>) {
  const result = filterIpcGraph(nodes, flows, { ...NO_IPC_FILTER, ...filter })
  return {
    nodes: result.nodes.map((node) => node.label),
    flows: result.flows.map((flow) => flow.id),
    focused: result.focused,
  }
}

describe('filterIpcGraph', () => {
  it('leaves the graph alone with no filter, routeless objects included', () => {
    const result = run({})
    expect(result.nodes).toEqual(nodes.map((node) => node.label))
    expect(result.flows).toEqual(flows.map((flow) => flow.id))
    expect(result.focused).toBe(false)
  })

  it('drops a hidden kind with its routes, and actors left with no route', () => {
    const result = run({ hiddenKinds: new Set(['msgq']) })
    expect(result.nodes).toEqual(['aggregator', 'logger', '[ISR]', 'log_fifo', 'keys'])
    expect(result.flows).toEqual(['f4', 'f5', 'f6'])
  })

  it('keeps a focused object and the actors with a route to it', () => {
    const result = run({ focus: 'object:10' })
    expect(result.nodes).toEqual(['sensor_a', 'sensor_b', 'aggregator', 'sensor_q'])
    expect(result.flows).toEqual(['f1', 'f2', 'f3'])
    expect(result.focused).toBe(true)
  })

  it('keeps a focused thread with its objects and whoever else uses them', () => {
    const result = run({ focus: 'thread:3' })
    expect(result.nodes).toEqual([
      'sensor_a',
      'sensor_b',
      'aggregator',
      'logger',
      'sensor_q',
      'log_fifo',
    ])
    expect(result.flows).toEqual(['f1', 'f2', 'f3', 'f4', 'f5'])
  })

  it('keeps a focused thread whose objects are all hidden, alone', () => {
    const result = run({ focus: 'thread:4', hiddenKinds: new Set(['fifo']) })
    expect(result.nodes).toEqual(['logger'])
    expect(result.flows).toEqual([])
    expect(result.focused).toBe(true)
  })

  it('ignores a focus on a node that is hidden or no longer there', () => {
    expect(run({ focus: 'object:10', hiddenKinds: new Set(['msgq']) }).focused).toBe(false)
    const stale = run({ focus: 'thread:99' })
    expect(stale.focused).toBe(false)
    expect(stale.flows).toEqual(flows.map((flow) => flow.id))
  })

  it('keeps name matches and their direct neighbours, case-insensitively', () => {
    const result = run({ query: '  LOG_ ' })
    expect(result.nodes).toEqual(['aggregator', 'logger', 'log_fifo'])
    expect(result.flows).toEqual(['f4', 'f5'])
  })

  it('matches a thread name, and keeps an object that matches with no route', () => {
    expect(run({ query: 'sensor_b' }).nodes).toEqual(['sensor_b', 'sensor_q'])
    expect(run({ query: 'spare' }).nodes).toEqual(['spare_q'])
  })

  it('applies a name inside the focus', () => {
    const result = run({ focus: 'thread:3', query: 'sensor_a' })
    expect(result.nodes).toEqual(['sensor_a', 'sensor_q'])
    expect(result.flows).toEqual(['f1'])
  })

  it('returns nothing when the name matches nothing', () => {
    const result = run({ query: 'nope' })
    expect(result.nodes).toEqual([])
    expect(result.flows).toEqual([])
  })
})

describe('filterIpcGraph: objects only one actor uses', () => {
  const syncNodes: FlowNodeSpec[] = [
    { id: 'thread:3', kind: 'thread', label: 'aggregator' },
    { id: 'thread:5', kind: 'thread', label: 'storage' },
    { id: 'sync:mutex:1', kind: 'mutex', label: 'bus_mutex' },
    { id: 'sync:mutex:2', kind: 'mutex', label: 'agg_mutex' },
    { id: 'sync:sem:3', kind: 'sem', label: 'unused_sem' },
  ]
  const syncFlows: FlowSpec[] = [
    { id: 'l1', actorId: 'thread:3', objectId: 'sync:mutex:1', action: 'lock', side: 'in' },
    { id: 'l2', actorId: 'thread:5', objectId: 'sync:mutex:1', action: 'lock', side: 'out' },
    { id: 'l3', actorId: 'thread:3', objectId: 'sync:mutex:2', action: 'lock', side: 'in' },
  ]
  const labels = (filter: Partial<IpcFilter>) =>
    filterIpcGraph(syncNodes, syncFlows, { ...NO_IPC_FILTER, ...filter }).nodes.map(
      (node) => node.label,
    )

  it('hides them by default, and counts them', () => {
    expect(labels({})).toEqual(['aggregator', 'storage', 'bus_mutex'])
    expect(filterIpcGraph(syncNodes, syncFlows, NO_IPC_FILTER).privateCount).toBe(2)
  })

  it('shows them when asked to, by the chip, a focus or a name', () => {
    expect(labels({ showPrivate: true })).toEqual(syncNodes.map((node) => node.label))
    expect(labels({ focus: 'sync:mutex:2' })).toEqual(['aggregator', 'agg_mutex'])
    expect(labels({ query: 'agg_' })).toEqual(['aggregator', 'agg_mutex'])
  })

  it('leaves queues with one actor alone: a queue filling up is news', () => {
    const result = filterIpcGraph(nodes, flows, NO_IPC_FILTER)
    expect(result.nodes.map((node) => node.label)).toContain('keys')
    expect(result.privateCount).toBe(0)
  })
})

describe('ipcKindCounts', () => {
  it('counts objects per kind, skipping actors', () => {
    expect([...ipcKindCounts(nodes)]).toEqual([
      ['msgq', 2],
      ['fifo', 1],
      ['stack', 1],
    ])
  })
})
