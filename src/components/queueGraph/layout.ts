import type {
  ElkEdgeSection,
  ElkExtendedEdge,
  ElkNode,
  ElkPoint,
  ElkPort,
} from 'elkjs/lib/elk-api'
import type {
  SemanticEdge,
  SemanticGraph,
  SemanticNode,
  SemanticPort,
} from './model'
import { isActorNode } from './model'

const PORT_SIZE = 7
const PORT_PITCH = 17

export interface LayoutPort extends SemanticPort {
  x: number
  y: number
  width: number
  height: number
}

type PositionedSemanticNode<Node extends SemanticNode> = Node extends SemanticNode
  ? Omit<Node, 'ports'> & {
      ports: LayoutPort[]
    }
  : never

export type LayoutNode = PositionedSemanticNode<SemanticNode> & {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEdge extends SemanticEdge {
  points: ElkPoint[]
}

/**
 * Which way the graph runs: left to right, or top to bottom. The model puts
 * entries on the west and exits on the east; top to bottom turns those into
 * north and south. A stack's top stays its top either way.
 */
export type GraphDirection = 'RIGHT' | 'DOWN'

export interface QueueGraphLayout {
  width: number
  height: number
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  direction: GraphDirection
}

const DOWN_SIDE: Record<SemanticPort['side'], SemanticPort['side']> = {
  WEST: 'NORTH',
  EAST: 'SOUTH',
  NORTH: 'NORTH',
  SOUTH: 'SOUTH',
}

function sideFor(port: SemanticPort, direction: GraphDirection): SemanticPort['side'] {
  return direction === 'DOWN' ? DOWN_SIDE[port.side] : port.side
}

/** Room the ports on one side need, along that side. */
function portExtent(node: SemanticNode, direction: GraphDirection, horizontal: boolean): number {
  const counts = new Map<SemanticPort['side'], number>()
  for (const port of node.ports) {
    const side = sideFor(port, direction)
    if ((side === 'NORTH' || side === 'SOUTH') === horizontal) {
      counts.set(side, (counts.get(side) ?? 0) + 1)
    }
  }
  return Math.max(1, ...counts.values()) * PORT_PITCH + 30
}

function nodeSize(node: SemanticNode, direction: GraphDirection): { width: number; height: number } {
  const across = portExtent(node, direction, true)
  const down = portExtent(node, direction, false)
  const vertical = direction === 'DOWN'
  if (isActorNode(node)) {
    return { width: Math.max(142, across), height: Math.max(62, down) }
  }
  if (node.kind === 'stack') {
    return { width: Math.max(166, across), height: 150 }
  }
  if (node.kind === 'lifo') {
    return { width: Math.max(156, across), height: 138 }
  }
  if (node.kind === 'msgq') {
    return vertical
      ? { width: Math.max(150, across), height: 190 }
      : { width: 238, height: Math.max(104, down) }
  }
  if (node.kind === 'mutex' || node.kind === 'condvar' || node.kind === 'sem') {
    return { width: Math.max(176, across), height: Math.max(48, down) }
  }
  return vertical
    ? { width: Math.max(150, across), height: 170 }
    : { width: 210, height: Math.max(96, down) }
}

function elkPort(port: SemanticPort, direction: GraphDirection): ElkPort {
  return {
    id: port.id,
    width: PORT_SIZE,
    height: PORT_SIZE,
    layoutOptions: {
      'elk.port.side': sideFor(port, direction),
      'elk.port.index': String(port.order),
      'elk.port.borderOffset': '0',
    },
  }
}

function elkNode(node: SemanticNode, direction: GraphDirection): ElkNode {
  const size = nodeSize(node, direction)
  return {
    id: node.id,
    width: size.width,
    height: size.height,
    ports: node.ports.map((port) => elkPort(port, direction)),
    layoutOptions: {
      'elk.portConstraints': 'FIXED_ORDER',
      'elk.spacing.portPort': String(PORT_PITCH - PORT_SIZE),
      'elk.spacing.portsSurrounding': '[top=16,left=16,bottom=16,right=16]',
    },
  }
}

function elkEdge(edge: SemanticEdge): ElkExtendedEdge {
  return {
    id: edge.id,
    sources: [edge.sourcePortId],
    targets: [edge.targetPortId],
    layoutOptions: {
      'elk.layered.priority.direction': edge.action === 'put-front' ? '1' : '10',
    },
  }
}

function edgePoints(section: ElkEdgeSection): ElkPoint[] {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
}

type ElkInstance = InstanceType<typeof import('elkjs/lib/elk.bundled.js').default>

let elkPromise: Promise<ElkInstance> | null = null

function loadElk(): Promise<ElkInstance> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK())
  return elkPromise
}

export async function layoutSemanticGraph(
  graph: SemanticGraph,
  direction: GraphDirection = 'RIGHT',
): Promise<QueueGraphLayout> {
  const root: ElkNode = {
    id: 'root',
    children: graph.nodes.map((node) => elkNode(node, direction)),
    edges: graph.edges.map(elkEdge),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=46,left=46,bottom=46,right=46]',
      'elk.spacing.nodeNode': '46',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.layered.spacing.edgeNodeBetweenLayers': '26',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '14',
      'elk.layered.feedbackEdges': 'true',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.portSortingStrategy': 'INPUT_ORDER',
      'elk.separateConnectedComponents': 'true',
      'elk.randomSeed': '1',
    },
  }

  const elk = await loadElk()
  const result = await elk.layout(root)
  const semanticNodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const semanticEdgeById = new Map(graph.edges.map((edge) => [edge.id, edge]))

  const nodes: LayoutNode[] = (result.children ?? []).map((node) => {
    const semantic = semanticNodeById.get(node.id)
    if (!semantic) throw new Error(`ELK returned unknown node ${node.id}`)
    const semanticPortById = new Map(semantic.ports.map((port) => [port.id, port]))
    const ports: LayoutPort[] = (node.ports ?? []).map((port) => {
      const spec = semanticPortById.get(port.id)
      if (!spec) throw new Error(`ELK returned unknown port ${port.id}`)
      return {
        ...spec,
        x: port.x ?? 0,
        y: port.y ?? 0,
        width: port.width ?? PORT_SIZE,
        height: port.height ?? PORT_SIZE,
      }
    })
    return {
      ...semantic,
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: node.width ?? 1,
      height: node.height ?? 1,
      ports,
    }
  })

  const edges: LayoutEdge[] = (result.edges ?? []).map((edge) => {
    const semantic = semanticEdgeById.get(edge.id)
    if (!semantic) throw new Error(`ELK returned unknown edge ${edge.id}`)
    const sections = edge.sections ?? []
    if (sections.length !== 1) {
      throw new Error(`Expected one route section for ${edge.id}, received ${sections.length}`)
    }
    return { ...semantic, points: edgePoints(sections[0]!) }
  })

  return {
    width: result.width ?? 1,
    height: result.height ?? 1,
    nodes,
    edges,
    direction,
  }
}
