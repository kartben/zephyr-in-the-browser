import { useEffect, useRef, useState, type RefObject } from 'react'

/** Target cell edge for wear-map grids — columns flex with the panel width. */
const CELL_PX = 12
const MAX_COLS = 48

/**
 * Column count that keeps heatmap cells near {@link CELL_PX} as the panel
 * resizes. Wider → more columns (shorter map, more room below); fewer cells
 * than that → one row that grows with the width.
 */
export function useFluidCols(count: number): {
  ref: RefObject<HTMLDivElement | null>
  cols: number
} {
  const ref = useRef<HTMLDivElement>(null)
  const fallback = Math.max(1, Math.min(MAX_COLS, Math.round(Math.sqrt(Math.max(count, 1)))))
  const [cols, setCols] = useState(() => Math.min(count || 1, Math.max(8, fallback)))

  useEffect(() => {
    const el = ref.current
    if (!el || count <= 0) return

    const apply = (width: number) => {
      if (width <= 0) return
      const next = Math.max(1, Math.min(count, MAX_COLS, Math.floor(width / CELL_PX)))
      setCols((prev) => (prev === next ? prev : next))
    }

    apply(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [count])

  return { ref, cols }
}
