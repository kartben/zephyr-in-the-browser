export interface GraphCamera {
  /** Screen-space translation before the world-space scale is applied. */
  x: number
  y: number
  /** Screen pixels per graph layout unit. */
  scale: number
}

export interface GraphViewportSize {
  width: number
  height: number
}

/** A node's box, in graph layout units. */
export interface GraphNodeBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const FIT_PADDING = 28

export function fitGraphCamera(
  graph: GraphViewportSize,
  viewport: GraphViewportSize,
): GraphCamera {
  const availableWidth = Math.max(1, viewport.width - FIT_PADDING * 2)
  const availableHeight = Math.max(1, viewport.height - FIT_PADDING * 2)
  const scale = Math.min(1, availableWidth / graph.width, availableHeight / graph.height)
  return {
    x: (viewport.width - graph.width * scale) / 2,
    y: (viewport.height - graph.height * scale) / 2,
    scale,
  }
}

export function zoomGraphCamera(
  camera: GraphCamera,
  factor: number,
  pivot: { x: number; y: number },
  minScale: number,
  maxScale: number,
): GraphCamera {
  const scale = Math.min(maxScale, Math.max(minScale, camera.scale * factor))
  const appliedFactor = scale / camera.scale
  return {
    x: pivot.x - (pivot.x - camera.x) * appliedFactor,
    y: pivot.y - (pivot.y - camera.y) * appliedFactor,
    scale,
  }
}

/**
 * Keep the graph's scale and the world point at the center stable when its
 * panel is resized. Extra width reveals more of the scene instead of zooming it.
 */
export function resizeGraphCamera(
  camera: GraphCamera,
  previous: GraphViewportSize,
  next: GraphViewportSize,
): GraphCamera {
  return {
    ...camera,
    x: camera.x + (next.width - previous.width) / 2,
    y: camera.y + (next.height - previous.height) / 2,
  }
}

/**
 * Carry the camera over to a new layout of the graph, so that what the user
 * zoomed in on stays in view: the node nearest the middle of the view, of
 * those in both layouts, keeps its place on screen, at the same scale. Null
 * when the layouts share no node.
 */
export function followGraphCamera(
  camera: GraphCamera,
  previous: readonly GraphNodeBox[],
  next: readonly GraphNodeBox[],
  viewport: GraphViewportSize,
): GraphCamera | null {
  const middle = {
    x: (viewport.width / 2 - camera.x) / camera.scale,
    y: (viewport.height / 2 - camera.y) / camera.scale,
  }
  const center = (box: GraphNodeBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const nextById = new Map(next.map((box) => [box.id, box]))
  let anchor: { from: GraphNodeBox; to: GraphNodeBox; distance: number } | null = null
  for (const from of previous) {
    const to = nextById.get(from.id)
    if (!to) continue
    const c = center(from)
    const distance = Math.hypot(c.x - middle.x, c.y - middle.y)
    if (!anchor || distance < anchor.distance) anchor = { from, to, distance }
  }
  if (!anchor) return null
  const from = center(anchor.from)
  const to = center(anchor.to)
  return {
    x: camera.x + (from.x - to.x) * camera.scale,
    y: camera.y + (from.y - to.y) * camera.scale,
    scale: camera.scale,
  }
}
