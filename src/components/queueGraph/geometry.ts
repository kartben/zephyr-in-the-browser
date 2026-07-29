import type { ElkPoint } from 'elkjs/lib/elk-api'
import type { LayoutEdge, LayoutNode, QueueGraphLayout } from './layout'

export interface GeometryIssue {
  kind: 'node-overlap' | 'edge-node' | 'non-orthogonal' | 'duplicate-port'
  message: string
}

type Rect = { left: number; right: number; top: number; bottom: number }

function nodeRect(node: LayoutNode, padding = 0): Rect {
  return {
    left: node.x - padding,
    right: node.x + node.width + padding,
    top: node.y - padding,
    bottom: node.y + node.height + padding,
  }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function segmentHitsRect(a: ElkPoint, b: ElkPoint, rect: Rect): boolean {
  if (Math.abs(a.y - b.y) < 0.01) {
    return (
      a.y > rect.top &&
      a.y < rect.bottom &&
      Math.max(a.x, b.x) > rect.left &&
      Math.min(a.x, b.x) < rect.right
    )
  }
  if (Math.abs(a.x - b.x) < 0.01) {
    return (
      a.x > rect.left &&
      a.x < rect.right &&
      Math.max(a.y, b.y) > rect.top &&
      Math.min(a.y, b.y) < rect.bottom
    )
  }
  return true
}

function edgeSegments(edge: LayoutEdge): Array<[ElkPoint, ElkPoint]> {
  const segments: Array<[ElkPoint, ElkPoint]> = []
  for (let i = 0; i < edge.points.length - 1; i++) {
    segments.push([edge.points[i]!, edge.points[i + 1]!])
  }
  return segments
}

export function validateQueueGraphLayout(layout: QueueGraphLayout): GeometryIssue[] {
  const issues: GeometryIssue[] = []

  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i]!
      const b = layout.nodes[j]!
      if (rectsOverlap(nodeRect(a, 8), nodeRect(b, 8))) {
        issues.push({
          kind: 'node-overlap',
          message: `${a.id} overlaps ${b.id}`,
        })
      }
    }
  }

  for (const node of layout.nodes) {
    const seen = new Set<string>()
    for (const port of node.ports) {
      const key = `${Math.round(port.x * 10)}:${Math.round(port.y * 10)}`
      if (seen.has(key)) {
        issues.push({
          kind: 'duplicate-port',
          message: `${node.id} has two ports at ${key}`,
        })
      }
      seen.add(key)
    }
  }

  for (const edge of layout.edges) {
    for (const [a, b] of edgeSegments(edge)) {
      if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) {
        issues.push({
          kind: 'non-orthogonal',
          message: `${edge.id} contains a diagonal segment`,
        })
      }
      for (const node of layout.nodes) {
        if (node.id === edge.sourceNodeId || node.id === edge.targetNodeId) continue
        if (segmentHitsRect(a, b, nodeRect(node, 5))) {
          issues.push({
            kind: 'edge-node',
            message: `${edge.id} intersects ${node.id}`,
          })
        }
      }
    }
  }

  return issues
}

export function roundedOrthogonalPath(points: ElkPoint[], radius = 9): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`

  const start = points[0]!
  let path = `M${start.x},${start.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]!
    const current = points[i]!
    const next = points[i + 1]!
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y)
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y)
    const r = Math.min(radius, incoming / 2, outgoing / 2)
    const before = {
      x: current.x - ((current.x - previous.x) / incoming) * r,
      y: current.y - ((current.y - previous.y) / incoming) * r,
    }
    const after = {
      x: current.x + ((next.x - current.x) / outgoing) * r,
      y: current.y + ((next.y - current.y) / outgoing) * r,
    }
    path += `L${before.x},${before.y}Q${current.x},${current.y} ${after.x},${after.y}`
  }
  const end = points.at(-1)!
  return `${path}L${end.x},${end.y}`
}
