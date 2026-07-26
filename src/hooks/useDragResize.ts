import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { PanelBox } from '@/lib/panelLayout'

const MIN_W = 192 // 12rem
const MIN_H = 96 // 6rem

export function clampBox(box: PanelBox): PanelBox {
  const w = Math.max(MIN_W, Math.round(box.w))
  const h = Math.max(MIN_H, Math.round(box.h))
  const maxX = Math.max(0, window.innerWidth - w)
  const maxY = Math.max(0, window.innerHeight - h)
  return {
    w,
    h,
    x: Math.min(Math.max(0, Math.round(box.x)), maxX),
    y: Math.min(Math.max(0, Math.round(box.y)), maxY),
  }
}

type Gesture = { pointerX: number; pointerY: number; box: PanelBox; mode: 'move' | 'resize' }

export function useDragResize(rect: PanelBox | null, onChange: (box: PanelBox) => void) {
  const gesture = useRef<Gesture | null>(null)
  // The resize listener is registered once; keep fresh rect/onChange in a ref.
  const latest = useRef({ rect, onChange })
  latest.current = { rect, onChange }

  // A shrinking viewport must not strand a floating panel off-screen.
  useEffect(() => {
    const onResize = () => {
      const { rect: current, onChange: update } = latest.current
      if (current) update(clampBox(current))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const begin = useCallback(
    (mode: 'move' | 'resize') => (event: ReactPointerEvent) => {
      // Header buttons must remain clickable, not start a drag.
      if (event.target instanceof Element && event.target.closest('button')) return
      const box = latest.current.rect
      if (!box) return
      event.preventDefault()
      gesture.current = { pointerX: event.clientX, pointerY: event.clientY, box, mode }
      try {
        // Capture keeps the drag alive past the panel edge.
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
        : { ...g.box, w: g.box.w + dx, h: g.box.h + dy }
    latest.current.onChange(clampBox(next))
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

  const handlers = (mode: 'move' | 'resize') => ({
    onPointerDown: begin(mode),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  })

  return { dragHandlers: handlers('move'), resizeHandlers: handlers('resize') }
}
