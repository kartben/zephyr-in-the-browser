export type QueueObjectKind = 'msgq' | 'fifo' | 'queue' | 'lifo' | 'stack'

export type SyncObjectKind = 'sem' | 'mutex' | 'condvar'

export type DataObjectKind = QueueObjectKind | SyncObjectKind

/**
 * give and signal make something available and take and wait wait for it, as
 * put and get do; lock is a mutex's, which its users both take and give back.
 */
export type FlowAction =
  | 'put'
  | 'put-front'
  | 'get'
  | 'push'
  | 'pop'
  | 'give'
  | 'take'
  | 'signal'
  | 'wait'
  | 'lock'

export type PortSide = 'NORTH' | 'EAST' | 'SOUTH' | 'WEST'

export type PortRole =
  | 'actor-in'
  | 'actor-out'
  | 'tail-in'
  | 'head-in'
  | 'head-out'
  | 'top-in'
  | 'top-out'
  | 'object-in'
  | 'object-out'

export interface ActorNodeSpec {
  id: string
  kind: 'thread' | 'isr'
  label: string
  detail?: string
}

export interface DataObjectNodeSpec {
  id: string
  kind: QueueObjectKind
  label: string
  depth: number
  capacity: number | null
}

export interface SyncObjectNodeSpec {
  id: string
  kind: SyncObjectKind
  label: string
}

export type FlowNodeSpec = ActorNodeSpec | DataObjectNodeSpec | SyncObjectNodeSpec

export interface FlowSpec {
  id: string
  actorId: string
  objectId: string
  action: FlowAction
  /**
   * lock: whether the actor sits before the mutex ('in') or after it ('out').
   * A lock has no direction of its own; this one lets the layout put the mutex
   * between its users.
   */
  side?: 'in' | 'out'
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
  /** The object's end of the edge, whichever way the edge runs. */
  objectNodeId: string
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
}

export function isActorNode(
  node: FlowNodeSpec,
): node is ActorNodeSpec {
  return node.kind === 'thread' || node.kind === 'isr'
}

export function isSyncKind(kind: FlowNodeSpec['kind']): kind is SyncObjectKind {
  return kind === 'sem' || kind === 'mutex' || kind === 'condvar'
}

export function isSyncNode(node: FlowNodeSpec): node is SyncObjectNodeSpec {
  return isSyncKind(node.kind)
}

/** Actions that move something from the actor to the object. */
export function isWriteAction(action: FlowAction): boolean {
  return (
    action === 'put' ||
    action === 'put-front' ||
    action === 'push' ||
    action === 'give' ||
    action === 'signal'
  )
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

function objectEndpoint(
  kind: DataObjectKind,
  action: FlowAction,
  side: FlowSpec['side'],
): ObjectEndpoint {
  if (isSyncKind(kind)) {
    if (action === 'give' || action === 'signal') {
      return { side: 'WEST', role: 'object-in', direction: 'in' }
    }
    if (action === 'take' || action === 'wait') {
      return { side: 'EAST', role: 'object-out', direction: 'out' }
    }
    if (action === 'lock' && kind === 'mutex') {
      return side === 'out'
        ? { side: 'EAST', role: 'object-out', direction: 'out' }
        : { side: 'WEST', role: 'object-in', direction: 'in' }
    }
    throw new Error(`${action} is not valid for a ${kind}`)
  }

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
 * actor → object for writes, object → actor for reads.
 *
 * Each flow receives a unique port at both endpoints. Port order is filled in
 * after grouping by side so ELK never needs to stack unrelated tips.
 */
export function buildSemanticGraph(nodeSpecs: FlowNodeSpec[], flowSpecs: FlowSpec[]): SemanticGraph {
  const nodes = nodeSpecs.map((node) => ({ ...node, ports: [] })) as SemanticNode[]
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges: SemanticEdge[] = []

  for (const flow of flowSpecs) {
    const actor = byId.get(flow.actorId)
    const object = byId.get(flow.objectId)
    if (!actor || !isActorNode(actor)) throw new Error(`Missing actor ${flow.actorId}`)
    if (!object || isActorNode(object)) throw new Error(`Missing data object ${flow.objectId}`)

    const endpoint = objectEndpoint(object.kind, flow.action, flow.side)
    const writes = endpoint.direction === 'in'
    const actorPort: SemanticPort = {
      id: portId(actor.id, flow.id),
      nodeId: actor.id,
      edgeId: flow.id,
      side: writes ? 'EAST' : 'WEST',
      role: writes ? 'actor-out' : 'actor-in',
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
    actor.ports.push(actorPort)
    object.ports.push(objectPort)

    edges.push({
      id: flow.id,
      action: flow.action,
      sourceNodeId: writes ? actor.id : object.id,
      sourcePortId: writes ? actorPort.id : objectPort.id,
      targetNodeId: writes ? object.id : actor.id,
      targetPortId: writes ? objectPort.id : actorPort.id,
      objectNodeId: object.id,
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
            'object-in': 0,
            'actor-in': 0,
            'actor-out': 1,
            'head-out': 1,
            'top-out': 1,
            'object-out': 1,
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
    case 'give':
      return 'give'
    case 'take':
      return 'take'
    case 'signal':
      return 'signal'
    case 'wait':
      return 'wait'
    case 'lock':
      return 'lock'
  }
}

export function flowActionColor(action: FlowAction): string {
  if (action === 'put-front') return '#f9a8d4'
  if (action === 'lock') return '#94a3b8'
  if (action === 'get' || action === 'pop' || action === 'take' || action === 'wait') {
    return '#fdba74'
  }
  return '#7dd3fc'
}
