/**
 * The shell every tour card shares: header, scrolling body, footer, and the
 * window manners. A card starts at its home, centered over the top of the
 * terminal, where it can cover exactly the output a step is about. Dragging the
 * header lifts it out to wherever the reader wants it, and every edge and
 * corner resizes it, the way a popped-out device window does (PanelFrame).
 * Double-clicking the header sends it home.
 *
 * The box lives in lib/tourLayout.ts, not here: each kind of card mounts its
 * own frame, and the card has to stay put as the tour moves between them.
 */

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { clampBox, useDragResize, type ResizeEdge } from '@/hooks/useDragResize'
import type { PanelBox } from '@/lib/panelLayout'
import { getTourLayout, setTourLayout, subscribeTourLayout } from '@/lib/tourLayout'
import { cn } from '@/lib/utils'

type Props = Omit<ComponentProps<'div'>, 'className' | 'style'> & {
  header: ReactNode
  footer: ReactNode
  /** Spacing for the body's own content. */
  bodyClassName?: string
  children: ReactNode
}

export function TourFrame({ header, footer, bodyClassName, children, ...rest }: Props) {
  const layout = useSyncExternalStore(subscribeTourLayout, getTourLayout, getTourLayout)
  const frame = useRef<HTMLDivElement>(null)

  // Until the reader sizes it, the card is as tall as its step: the drag and
  // the viewport clamp have to work from that height, not a stored one.
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    const el = frame.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const box: PanelBox | null = layout
    ? { x: layout.x, y: layout.y, w: layout.w, h: layout.sized ? layout.h : (height ?? layout.h) }
    : null

  // Pulling the top or bottom edge fixes the height; a move or a sideways pull
  // leaves the card sizing to its content.
  const vertical = useRef(false)
  const { dragHandlers, resizeHandlers } = useDragResize(
    box,
    (next) =>
      setTourLayout({ ...next, sized: (getTourLayout()?.sized ?? false) || vertical.current }),
    {
      seed: () => {
        const r = frame.current?.getBoundingClientRect()
        return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
      },
    },
  )

  // A step taller than the last, or a box saved on a bigger screen, must not
  // leave the card hanging off the bottom of the window.
  useEffect(() => {
    if (!box) return
    const clamped = clampBox(box)
    if (clamped.x !== box.x || clamped.y !== box.y) setTourLayout({ ...clamped, sized: layout!.sized })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box?.x, box?.y, box?.w, box?.h])

  const sized = layout?.sized === true

  return (
    <div
      {...rest}
      ref={frame}
      className={cn(
        'pointer-events-auto relative flex flex-col rounded-lg border border-primary/40 bg-card/95 shadow-xl backdrop-blur',
        layout ? 'fixed' : 'w-full max-w-[34rem]',
      )}
      style={
        layout
          ? { left: layout.x, top: layout.y, width: layout.w, ...(sized ? { height: layout.h } : {}) }
          : undefined
      }
    >
      <div
        {...dragHandlers}
        onPointerDown={(event) => {
          vertical.current = false
          dragHandlers.onPointerDown(event)
        }}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest('button')) return
          setTourLayout(null)
        }}
        title={layout ? 'Double-click to put the card back' : undefined}
        className="flex cursor-move touch-none select-none items-center gap-2 border-b border-border px-3 py-2"
      >
        {header}
      </div>

      <div
        className={cn(
          'overflow-y-auto',
          sized ? 'min-h-0 flex-1' : 'max-h-[min(30rem,64vh)]',
          bodyClassName,
        )}
      >
        {children}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">{footer}</div>

      {RESIZE_GRIPS.map(({ edge, className }) => {
        const handlers = resizeHandlers(edge)
        return (
          <div
            key={edge}
            {...handlers}
            onPointerDown={(event) => {
              vertical.current = edge.includes('n') || edge.includes('s')
              handlers.onPointerDown(event)
            }}
            role="presentation"
            aria-hidden
            className={cn('absolute touch-none', className)}
          />
        )
      })}
      {/* The corner people look for, as on a device window. */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 size-3 rounded-br-lg"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, var(--color-border) 50% 60%, transparent 60% 70%, var(--color-border) 70% 80%, transparent 80%)',
        }}
      />
    </div>
  )
}

/** PanelFrame's grips: inside the card, narrow, corners last so they win. */
const RESIZE_GRIPS: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: 'n', className: 'top-0 left-3.5 right-3.5 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-3.5 right-3.5 h-1.5 cursor-ns-resize' },
  { edge: 'w', className: 'left-0 top-3.5 bottom-3.5 w-1.5 cursor-ew-resize' },
  { edge: 'e', className: 'right-0 top-3.5 bottom-3.5 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 size-3 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 size-3 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 size-3 cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 size-3 cursor-nwse-resize' },
]
