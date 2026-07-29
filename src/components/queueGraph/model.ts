export type DataObjectKind = 'msgq' | 'fifo' | 'queue' | 'lifo' | 'stack'

export type FlowAction = 'put' | 'put-front' | 'get' | 'push' | 'pop'

export type PortSide = 'NORTH' | 'EAST' | 'SOUTH' | 'WEST'

export type PortRole =
  | 'thread-in'
  | 'thread-out'
  | 'tail-in'
  | 'head-in'
  | 'head-out'
  | 'top-in'
  | 'top-out'

export interface ThreadNodeSpec {
  id: string
  kind: 'thread'
  label: string
  detail?: string
}

export interface DataObjectNodeSpec {
  id: string
  kind: DataObjectKind
  label: string
  depth: number
  capacity: number | null
}

export type FlowNodeSpec = ThreadNodeSpec | DataObjectNodeSpec

export interface FlowSpec {
  id: string
  threadId: string
  objectId: string
  action: FlowAction
}

export interface SemanticPort {
  id: string
  nodeId: string
  edgeId: string
  side: PortSide
  role: PortRole
  direction: 'in' | 'out'
  order: number
}

export type SemanticNode = FlowNodeSpec & {
  ports: SemanticPort[]
}

export interface SemanticEdge {
  id: string
  action: FlowAction
  sourceNodeId: string
  sourcePortId: string
  targetNodeId: string
  targetPortId: string
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
}

function groupPortsBySide(ports: SemanticPort[]): Map<PortSide, SemanticPort[]> {
  const grouped = new Map<PortSide, SemanticPort[]>()
  for (const port of ports) {
    const group = grouped.get(port.side) ?? []
    group.push(port)
    grouped.set(port.side, group)
  }
  return grouped
}

type ObjectEndpoint = {
  side: PortSide
  role: PortRole
  direction: 'in' | 'out'
}

function objectEndpoint(kind: DataObjectKind, action: FlowAction): ObjectEndpoint {
  if (kind === 'stack') {
    if (action === 'push') return { side: 'NORTH', role: 'top-in', direction: 'in' }
    if (action === 'pop') return { side: 'NORTH', role: 'top-out', direction: 'out' }
    throw new Error(`${action} is not valid for a stack`)
  }

  if (kind === 'lifo') {
    if (action === 'put' || action === 'put-front' || action === 'push') {
      return { side: 'NORTH', role: 'top-in', direction: 'in' }
    }
    if (action === 'get' || action === 'pop') {
      return { side: 'NORTH', role: 'top-out', direction: 'out' }
    }
  }

  if (action === 'put') return { side: 'WEST', role: 'tail-in', direction: 'in' }
  if (action === 'put-front') return { side: 'EAST', role: 'head-in', direction: 'in' }
  if (action === 'get') return { side: 'EAST', role: 'head-out', direction: 'out' }

  throw new Error(`${action} is not valid for a ${kind}`)
}

function portId(nodeId: string, edgeId: string): string {
  return `${nodeId}:port:${edgeId}`
}

/**
 * Build a graph whose direction follows the data:
 * thread → object for writes, object → thread for reads.
 *
 * Each flow receives a unique port at both endpoints. Port order is filled in
 * after grouping by side so ELK never needs to stack unrelated tips.
 */
export function buildSemanticGraph(nodeSpecs: FlowNodeSpec[], flowSpecs: FlowSpec[]): SemanticGraph {
  const nodes = nodeSpecs.map((node) => ({ ...node, ports: [] })) as SemanticNode[]
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges: SemanticEdge[] = []

  for (const flow of flowSpecs) {
    const thread = byId.get(flow.threadId)
    const object = byId.get(flow.objectId)
    if (!thread || thread.kind !== 'thread') throw new Error(`Missing thread ${flow.threadId}`)
    if (!object || object.kind === 'thread') throw new Error(`Missing data object ${flow.objectId}`)

    const endpoint = objectEndpoint(object.kind, flow.action)
    const writes = endpoint.direction === 'in'
    const threadPort: SemanticPort = {
      id: portId(thread.id, flow.id),
      nodeId: thread.id,
      edgeId: flow.id,
      side: writes ? 'EAST' : 'WEST',
      role: writes ? 'thread-out' : 'thread-in',
      direction: writes ? 'out' : 'in',
      order: 0,
    }
    const objectPort: SemanticPort = {
      id: portId(object.id, flow.id),
      nodeId: object.id,
      edgeId: flow.id,
      ...endpoint,
      order: 0,
    }
    thread.ports.push(threadPort)
    object.ports.push(objectPort)

    edges.push({
      id: flow.id,
      action: flow.action,
      sourceNodeId: writes ? thread.id : object.id,
      sourcePortId: writes ? threadPort.id : objectPort.id,
      targetNodeId: writes ? object.id : thread.id,
      targetPortId: writes ? objectPort.id : threadPort.id,
    })
  }

  for (const node of nodes) {
    const grouped = groupPortsBySide(node.ports)
    for (const ports of grouped.values()) {
      ports
        .sort((a, b) => {
          const roleOrder: Record<PortRole, number> = {
            'tail-in': 0,
            'head-in': 0,
            'top-in': 0,
            'thread-in': 0,
            'thread-out': 1,
            'head-out': 1,
            'top-out': 1,
          }
          return roleOrder[a.role] - roleOrder[b.role] || a.edgeId.localeCompare(b.edgeId)
        })
        .forEach((port, order) => {
          port.order = order
        })
    }
  }

  return { nodes, edges }
}

export function flowActionLabel(action: FlowAction): string {
  switch (action) {
    case 'put':
      return 'put'
    case 'put-front':
      return 'put front'
    case 'get':
      return 'get'
    case 'push':
      return 'push'
    case 'pop':
      return 'pop'
  }
}

export function flowActionColor(action: FlowAction): string {
  if (action === 'put-front') return '#f9a8d4'
  if (action === 'get' || action === 'pop') return '#fdba74'
  return '#7dd3fc'
}
