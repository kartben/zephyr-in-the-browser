import { describe, expect, it } from 'vitest'
import type { FlowAction, FlowNodeSpec, FlowSpec } from './model'
import { orientLocks } from './orient'

const thread = (id: string): FlowNodeSpec => ({ id, kind: 'thread', label: id })
const flow = (actorId: string, action: FlowAction, objectId: string): FlowSpec => ({
  id: `${actorId}-${action}-${objectId}`,
  actorId,
  objectId,
  action,
})

function sides(nodes: FlowNodeSpec[], flows: FlowSpec[]): Record<string, string | undefined> {
  return Object.fromEntries(
    orientLocks(nodes, flows)
      .filter((f) => f.action === 'lock')
      .map((f) => [`${f.actorId}@${f.objectId}`, f.side]),
  )
}

describe('orientLocks', () => {
  it('puts each mutex of the sensor pipeline between the threads that share it', () => {
    const nodes: FlowNodeSpec[] = [
      ...['sensor_temp', 'sensor_imu', 'aggregator', 'consumer0', 'consumer1', 'storage'].map(thread),
      { id: 'sensor_q', kind: 'msgq', label: 'sensor_q', depth: 0, capacity: 16 },
      { id: 'frame_cond', kind: 'condvar', label: 'frame_cond' },
      { id: 'frame_mutex', kind: 'mutex', label: 'frame_mutex' },
      { id: 'bus_mutex', kind: 'mutex', label: 'bus_mutex' },
      { id: 'agg_mutex', kind: 'mutex', label: 'agg_mutex' },
    ]
    const flows = [
      flow('sensor_temp', 'put', 'sensor_q'),
      flow('sensor_imu', 'put', 'sensor_q'),
      flow('aggregator', 'get', 'sensor_q'),
      flow('aggregator', 'signal', 'frame_cond'),
      flow('consumer0', 'wait', 'frame_cond'),
      flow('consumer1', 'wait', 'frame_cond'),
      flow('aggregator', 'lock', 'frame_mutex'),
      flow('consumer0', 'lock', 'frame_mutex'),
      flow('consumer1', 'lock', 'frame_mutex'),
      flow('aggregator', 'lock', 'bus_mutex'),
      flow('storage', 'lock', 'bus_mutex'),
      flow('aggregator', 'lock', 'agg_mutex'),
    ]
    expect(sides(nodes, flows)).toEqual({
      'aggregator@frame_mutex': 'in',
      'consumer0@frame_mutex': 'out',
      'consumer1@frame_mutex': 'out',
      'aggregator@bus_mutex': 'in',
      'storage@bus_mutex': 'out',
      'aggregator@agg_mutex': 'in',
    })
  })

  it('puts every user on one side when nothing else ranks them', () => {
    const nodes: FlowNodeSpec[] = [
      ...['p0', 'p1', 'p2'].map(thread),
      ...['fork0', 'fork1', 'fork2'].map((id): FlowNodeSpec => ({ id, kind: 'mutex', label: id })),
    ]
    const flows = [
      flow('p0', 'lock', 'fork0'),
      flow('p0', 'lock', 'fork1'),
      flow('p1', 'lock', 'fork1'),
      flow('p1', 'lock', 'fork2'),
      flow('p2', 'lock', 'fork2'),
      flow('p2', 'lock', 'fork0'),
    ]
    expect(new Set(Object.values(sides(nodes, flows)))).toEqual(new Set(['in']))
  })

  it('ranks a cycle as one, so the threads in it share a side', () => {
    const nodes: FlowNodeSpec[] = [
      ...['a', 'b', 'c'].map(thread),
      { id: 'q1', kind: 'msgq', label: 'q1', depth: 0, capacity: 4 },
      { id: 'q2', kind: 'msgq', label: 'q2', depth: 0, capacity: 4 },
      { id: 'q3', kind: 'fifo', label: 'q3', depth: 0, capacity: null },
      { id: 'm', kind: 'mutex', label: 'm' },
    ]
    const flows = [
      flow('a', 'put', 'q1'),
      flow('b', 'get', 'q1'),
      flow('b', 'put', 'q2'),
      flow('a', 'get', 'q2'),
      flow('b', 'put', 'q3'),
      flow('c', 'get', 'q3'),
      flow('a', 'lock', 'm'),
      flow('b', 'lock', 'm'),
      flow('c', 'lock', 'm'),
    ]
    expect(sides(nodes, flows)).toEqual({ 'a@m': 'in', 'b@m': 'in', 'c@m': 'out' })
  })

  it('leaves a semaphore used as a lock out of the ranking', () => {
    const nodes: FlowNodeSpec[] = [
      ...['producer', 'consumer'].map(thread),
      { id: 'q', kind: 'msgq', label: 'q', depth: 0, capacity: 4 },
      { id: 'bus_sem', kind: 'sem', label: 'bus_sem' },
      { id: 'm', kind: 'mutex', label: 'm' },
    ]
    const flows = [
      flow('producer', 'put', 'q'),
      flow('consumer', 'get', 'q'),
      // Taken and given by both, the semaphore would close a cycle through
      // the producer and the consumer, and give them one rank.
      flow('producer', 'take', 'bus_sem'),
      flow('producer', 'give', 'bus_sem'),
      flow('consumer', 'take', 'bus_sem'),
      flow('consumer', 'give', 'bus_sem'),
      flow('producer', 'lock', 'm'),
      flow('consumer', 'lock', 'm'),
    ]
    expect(sides(nodes, flows)).toEqual({ 'producer@m': 'in', 'consumer@m': 'out' })
  })

  it('leaves every other route as it was', () => {
    const nodes = [thread('t'), { id: 'q', kind: 'msgq', label: 'q', depth: 0, capacity: 1 } as FlowNodeSpec]
    const flows = [flow('t', 'put', 'q')]
    expect(orientLocks(nodes, flows)).toEqual(flows)
  })
})
