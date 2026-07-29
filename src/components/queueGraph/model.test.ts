import { describe, expect, it } from 'vitest'
import { buildSemanticGraph, type FlowNodeSpec, type FlowSpec } from './model'

const nodes: FlowNodeSpec[] = [
  { id: 't', kind: 'thread', label: 'worker' },
  { id: 'isr', kind: 'isr', label: '[ISR]', detail: 'interrupt context' },
  { id: 'q', kind: 'msgq', label: 'messages', depth: 0, capacity: 4 },
  { id: 's', kind: 'stack', label: 'stack', depth: 0, capacity: 8 },
]

describe('buildSemanticGraph', () => {
  it('assigns unique semantic ports to queue head and tail operations', () => {
    const flows: FlowSpec[] = [
      { id: 'put', actorId: 't', objectId: 'q', action: 'put' },
      { id: 'front', actorId: 't', objectId: 'q', action: 'put-front' },
      { id: 'get', actorId: 't', objectId: 'q', action: 'get' },
    ]
    const graph = buildSemanticGraph(nodes, flows)
    const queue = graph.nodes.find((node) => node.id === 'q')!

    expect(new Set(queue.ports.map((port) => port.id))).toHaveLength(3)
    expect(queue.ports.find((port) => port.edgeId === 'put')).toMatchObject({
      side: 'WEST',
      role: 'tail-in',
    })
    expect(queue.ports.find((port) => port.edgeId === 'front')).toMatchObject({
      side: 'EAST',
      role: 'head-in',
    })
    expect(queue.ports.find((port) => port.edgeId === 'get')).toMatchObject({
      side: 'EAST',
      role: 'head-out',
    })
  })

  it('puts stack push and pop ports exclusively on top', () => {
    const graph = buildSemanticGraph(nodes, [
      { id: 'push', actorId: 't', objectId: 's', action: 'push' },
      { id: 'pop', actorId: 't', objectId: 's', action: 'pop' },
    ])
    const stack = graph.nodes.find((node) => node.id === 's')!

    expect(stack.ports.map((port) => port.side)).toEqual(['NORTH', 'NORTH'])
    expect(stack.ports.map((port) => port.role)).toEqual(['top-in', 'top-out'])
  })

  it('routes ISR writes through a first-class actor node', () => {
    const graph = buildSemanticGraph(nodes, [
      { id: 'isr-put', actorId: 'isr', objectId: 'q', action: 'put' },
    ])
    const edge = graph.edges[0]!

    expect(graph.nodes.find((node) => node.id === 'isr')).toMatchObject({
      kind: 'isr',
      label: '[ISR]',
    })
    expect(edge).toMatchObject({
      sourceNodeId: 'isr',
      targetNodeId: 'q',
      action: 'put',
    })
  })
})
