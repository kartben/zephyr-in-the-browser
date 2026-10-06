import { describe, expect, it } from 'vitest'
import {
  queueGraphMock,
  queueGraphPhilosophersMockSpecs,
  queueGraphRoutingStressMock,
  queueGraphSensorPipelineMockSpecs,
} from '@/mocks/queueGraphMockData'
import { validateQueueGraphLayout } from './geometry'
import { layoutSemanticGraph } from './layout'
import { buildSemanticGraph, type FlowNodeSpec, type FlowSpec } from './model'

describe('layoutSemanticGraph', () => {
  it('produces a collision-free orthogonal layout for the review topology', async () => {
    const layout = await layoutSemanticGraph(queueGraphMock)
    expect(layout.nodes).toHaveLength(queueGraphMock.nodes.length)
    expect(layout.edges).toHaveLength(queueGraphMock.edges.length)
    expect(validateQueueGraphLayout(layout)).toEqual([])
  })

  it('expands a high-degree object instead of sharing or stacking ports', async () => {
    const threadNodes: FlowNodeSpec[] = Array.from({ length: 12 }, (_, index) => ({
      id: `thread:${index}`,
      kind: 'thread',
      label: `producer_${index}`,
    }))
    const nodes: FlowNodeSpec[] = [
      ...threadNodes,
      { id: 'object:busy', kind: 'msgq', label: 'busy_msgq', depth: 5, capacity: 16 },
    ]
    const flows: FlowSpec[] = threadNodes.map((thread, index) => ({
      id: `flow:${index}`,
      actorId: thread.id,
      objectId: 'object:busy',
      action: 'put',
    }))
    const graph = buildSemanticGraph(nodes, flows)
    const layout = await layoutSemanticGraph(graph)
    const object = layout.nodes.find((node) => node.id === 'object:busy')!
    const positions = object.ports.map((port) => `${port.x}:${port.y}`)

    expect(new Set(positions).size).toBe(12)
    expect(object.height).toBeGreaterThan(200)
    expect(validateQueueGraphLayout(layout)).toEqual([])
  })

  it('routes the 3× mixed-object stress topology without geometry violations', async () => {
    const layout = await layoutSemanticGraph(queueGraphRoutingStressMock)

    expect(layout.nodes).toHaveLength(19)
    expect(layout.edges).toHaveLength(25)
    expect(validateQueueGraphLayout(layout)).toEqual([])
  })

  it('puts each mutex of the sensor pipeline between the threads that share it', async () => {
    const { nodes, flows } = queueGraphSensorPipelineMockSpecs
    const layout = await layoutSemanticGraph(buildSemanticGraph(nodes, flows))
    const x = (id: string) => layout.nodes.find((node) => node.id === id)!.x

    expect(validateQueueGraphLayout(layout)).toEqual([])
    for (const mutex of ['object:bus_mutex', 'object:frame_mutex']) {
      expect(x('thread:aggregator')).toBeLessThan(x(mutex))
    }
    expect(x('object:bus_mutex')).toBeLessThan(x('thread:storage'))
    expect(x('object:frame_mutex')).toBeLessThan(x('thread:consumer0'))
  })

  it('lays out a ring of philosophers and forks without geometry violations', async () => {
    const { nodes, flows } = queueGraphPhilosophersMockSpecs
    const layout = await layoutSemanticGraph(buildSemanticGraph(nodes, flows))

    expect(layout.edges).toHaveLength(10)
    expect(validateQueueGraphLayout(layout)).toEqual([])
  })
})
