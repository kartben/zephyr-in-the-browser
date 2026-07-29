import ELK from 'elkjs/lib/elk.bundled.js'
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

export interface QueueGraphLayout {
  width: number
  height: number
  nodes: LayoutNode[]
  edges: LayoutEdge[]
}

function maxPortsOnSide(node: SemanticNode): number {
  const counts = new Map<SemanticPort['side'], number>()
  for (const port of node.ports) counts.set(port.side, (counts.get(port.side) ?? 0) + 1)
  return Math.max(1, ...counts.values())
}

function nodeSize(node: SemanticNode): { width: number; height: number } {
  const pitchExtent = maxPortsOnSide(node) * PORT_PITCH + 30
  if (node.kind === 'thread') {
    return { width: 142, height: Math.max(62, pitchExtent) }
  }
  if (node.kind === 'stack') {
    return { width: Math.max(166, pitchExtent), height: 150 }
  }
  if (node.kind === 'lifo') {
    return { width: Math.max(156, pitchExtent), height: 138 }
  }
  if (node.kind === 'msgq') {
    return { width: 238, height: Math.max(104, pitchExtent) }
  }
  return { width: 210, height: Math.max(96, pitchExtent) }
}

function elkPort(port: SemanticPort): ElkPort {
  return {
    id: port.id,
    width: PORT_SIZE,
    height: PORT_SIZE,
    layoutOptions: {
      'elk.port.side': port.side,
      'elk.port.index': String(port.order),
      'elk.port.borderOffset': '0',
    },
  }
}

function elkNode(node: SemanticNode): ElkNode {
  const size = nodeSize(node)
  return {
    id: node.id,
    width: size.width,
    height: size.height,
    ports: node.ports.map(elkPort),
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

const elk = new ELK()

export async function layoutSemanticGraph(graph: SemanticGraph): Promise<QueueGraphLayout> {
  const root: ElkNode = {
    id: 'root',
    children: graph.nodes.map(elkNode),
    edges: graph.edges.map(elkEdge),
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
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
  }
}
