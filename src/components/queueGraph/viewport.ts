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
