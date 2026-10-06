import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { layoutSemanticGraph, type GraphDirection, type QueueGraphLayout } from './layout'
import type { SemanticGraph } from './model'
import { fitGraphCamera, type GraphViewportSize } from './viewport'

/** Layouts kept by direction and topology, so clearing a filter puts the graph back at once. */
const CACHE_SIZE = 16
/** How much larger the other direction must draw the graph before the picture turns. */
const TURN_GAIN = 1.15

/**
 * The direction that draws the graph larger in `viewport`. The dock is taller
 * than it is wide, and a pipeline read top to bottom comes up there at about
 * twice the size; a wide window suits left to right. The picture only turns
 * for a clearly larger one, so a resize near the tie does not flip it back and
 * forth, and a graph that fits either way stays left to right.
 */
export function pickDirection(
  current: GraphDirection | null,
  right: QueueGraphLayout,
  down: QueueGraphLayout,
  viewport: GraphViewportSize,
): GraphDirection {
  const across = fitGraphCamera(right, viewport).scale
  const below = fitGraphCamera(down, viewport).scale
  if (current === 'DOWN') return across > below * TURN_GAIN ? 'RIGHT' : 'DOWN'
  return below > across * TURN_GAIN ? 'DOWN' : 'RIGHT'
}

/** The element's size, kept up to date, or null until it has been measured. */
export function useElementSize(ref: RefObject<HTMLElement | null>): GraphViewportSize | null {
  const [size, setSize] = useState<GraphViewportSize | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize((current) =>
        current && current.width === rect.width && current.height === rect.height
          ? current
          : { width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * Lay the graph out both ways and keep the one {@link pickDirection} prefers
 * for `viewport`, or `force`'s. Until both are ready for a new topology, the
 * last layout stays up rather than flashing one direction before the other.
 */
export function useFittedLayout(
  request: { key: string; graph: SemanticGraph },
  viewport: GraphViewportSize | null,
  force?: GraphDirection,
): { layout: QueueGraphLayout | null; error: string | null } {
  const cacheRef = useRef(new Map<string, QueueGraphLayout>())
  const directionRef = useRef<GraphDirection | null>(null)
  const [both, setBoth] = useState<{
    key: string
    RIGHT?: QueueGraphLayout
    DOWN?: QueueGraphLayout
  } | null>(null)
  const [layout, setLayout] = useState<QueueGraphLayout | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    const cache = cacheRef.current
    let current = true
    for (const direction of ['RIGHT', 'DOWN'] as const) {
      const cacheKey = `${direction}|${request.key}`
      const cached = cache.get(cacheKey)
      const pending = cached
        ? Promise.resolve(cached)
        : layoutSemanticGraph(request.graph, direction).then((next) => {
            cache.set(cacheKey, next)
            if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
            return next
          })
      pending
        .then((next) => {
          if (!current) return
          setBoth((previous) =>
            previous?.key === request.key
              ? { ...previous, [direction]: next }
              : { key: request.key, [direction]: next },
          )
        })
        .catch((reason: unknown) => {
          if (current) setError(reason instanceof Error ? reason.message : String(reason))
        })
    }
    return () => {
      current = false
    }
  }, [request])

  useEffect(() => {
    if (!both?.RIGHT || !both.DOWN) return
    const direction =
      force ?? (viewport ? pickDirection(directionRef.current, both.RIGHT, both.DOWN, viewport) : 'RIGHT')
    directionRef.current = direction
    setLayout(both[direction]!)
  }, [both, viewport, force])

  return { layout, error }
}
