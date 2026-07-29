import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { PanelBox } from '@/lib/panelLayout'

/**
 * Move + resize for a floating panel, built on the same setPointerCapture idiom
 * the display canvas uses (src/components/DisplayPanel.tsx): capture keeps the
 * gesture alive past the element's edge, so no pointer can be left stuck down.
 *
 * PanelFrame owns the rect (so it can persist); this hook just turns pointer
 * drags into clamped rect updates and hands back header + grip handlers.
 */

const MIN_W = 192 // 12rem
const MIN_H = 96 // 6rem

export type ClampBoxOpts = {
  /**
   * Height used only for vertical viewport clamping (e.g. a collapsed
   * header). Stored `box.h` is left alone so expand can restore full size.
   */
  visibleHeight?: number
}

/** Keep a box at least MIN sized and fully inside the viewport. */
export function clampBox(box: PanelBox, opts?: ClampBoxOpts): PanelBox {
  const w = Math.max(MIN_W, Math.round(box.w))
  const h = Math.max(MIN_H, Math.round(box.h))
  const clampH =
    opts?.visibleHeight != null ? Math.max(1, Math.round(opts.visibleHeight)) : h
  const maxX = Math.max(0, window.innerWidth - w)
  const maxY = Math.max(0, window.innerHeight - clampH)
  return {
    w,
    h,
    x: Math.min(Math.max(0, Math.round(box.x)), maxX),
    y: Math.min(Math.max(0, Math.round(box.y)), maxY),
  }
}

/**
 * Which edge (or corner) a resize gesture is pulling. A window can be sized
 * from any of them, the way a window manager's are — there is no reason the
 * bottom-right corner should be the only way to make a card wider.
 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type Gesture = {
  pointerX: number
  pointerY: number
  box: PanelBox
  mode: 'move' | ResizeEdge
}

/**
 * Apply a pointer delta to one edge. Pulling the north or west side moves the
 * origin as well as the size, and stops moving it once MIN is reached — so a
 * card being shrunk from the top does not creep downward past its minimum.
 */
export function resizeBox(box: PanelBox, edge: ResizeEdge, dx: number, dy: number): PanelBox {
  let { x, y, w, h } = box
  if (edge.includes('e')) w = box.w + dx
  if (edge.includes('s')) h = box.h + dy
  if (edge.includes('w')) {
    w = Math.max(MIN_W, box.w - dx)
    x = box.x + (box.w - w)
  }
  if (edge.includes('n')) {
    h = Math.max(MIN_H, box.h - dy)
    y = box.y + (box.h - h)
  }
  return { x, y, w, h }
}

export function useDragResize(
  rect: PanelBox | null,
  onChange: (box: PanelBox) => void,
  opts?: ClampBoxOpts,
) {
  const gesture = useRef<Gesture | null>(null)
  // The window-resize listener is registered once; this ref keeps the freshest
  // rect/onChange reachable from it without re-subscribing on every change.
  const latest = useRef({ rect, onChange, opts })
  latest.current = { rect, onChange, opts }

  // A shrinking viewport must not strand a floating panel off-screen.
  useEffect(() => {
    const onResize = () => {
      const { rect: current, onChange: update, opts: clampOpts } = latest.current
      if (current) update(clampBox(current, clampOpts))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const begin = useCallback(
    (mode: 'move' | ResizeEdge) => (event: ReactPointerEvent) => {
      // Let clicks on the header controls (undock/collapse/close) through — a
      // drag must never swallow a button press.
      if (event.target instanceof Element && event.target.closest('button')) return
      const box = latest.current.rect
      if (!box) return
      event.preventDefault()
      gesture.current = { pointerX: event.clientX, pointerY: event.clientY, box, mode }
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* nothing to capture — moves still fire while the pointer is over us */
      }
    },
    [],
  )

  const move = useCallback((event: ReactPointerEvent) => {
    const g = gesture.current
    if (!g) return
    const dx = event.clientX - g.pointerX
    const dy = event.clientY - g.pointerY
    const next =
      g.mode === 'move'
        ? { ...g.box, x: g.box.x + dx, y: g.box.y + dy }
        : resizeBox(g.box, g.mode, dx, dy)
    // Resize always clamps against the live box height; move may use a
    // shorter visibleHeight (collapsed header) so the strip can sit lower.
    const clampOpts = g.mode === 'move' ? latest.current.opts : undefined
    latest.current.onChange(clampBox(next, clampOpts))
  }, [])

  const end = useCallback((event: ReactPointerEvent) => {
    if (!gesture.current) return
    gesture.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
  }, [])

  const handlers = (mode: 'move' | ResizeEdge) => ({
    onPointerDown: begin(mode),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  })

  return {
    dragHandlers: handlers('move'),
    /** Pointer handlers for one edge or corner grip. */
    resizeHandlers: (edge: ResizeEdge) => handlers(edge),
  }
}
