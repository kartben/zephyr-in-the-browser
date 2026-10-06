/**
 * The shell every tour card shares: header, scrolling body, footer, and the
 * window manners. A card starts at its home, against the right of the stage,
 * next to the dock its steps point at and clear of the terminal's left-aligned
 * output, and grows to the stage's height before its body scrolls. Dragging the
 * header lifts it out to wherever the reader wants it, and every edge and
 * corner resizes it, the way a popped-out device window does (PanelFrame).
 * Double-clicking the header sends it home. Minimised, only the header shows,
 * one line the reader can look past; the body stays mounted, so it comes back
 * scrolled where it was.
 *
 * The box lives in lib/tourLayout.ts, not here: each kind of card mounts its
 * own frame, and the card has to stay put as the tour moves between them.
 */

import {
  useCallback,
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
  /** Show the header alone: the card folded to one line. */
  minimised?: boolean
  children: ReactNode
}

export function TourFrame({
  header,
  footer,
  bodyClassName,
  minimised = false,
  children,
  ...rest
}: Props) {
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

  // Whether the body has more below what it shows. The scroller's own box
  // stops changing once it reaches its limit, so watch the content inside it.
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const measureMore = useCallback(() => {
    const el = scroller.current
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }, [])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureMore)
    if (scroller.current) observer.observe(scroller.current)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [measureMore])

  return (
    <div
      {...rest}
      ref={frame}
      className={cn(
        'pointer-events-auto relative flex flex-col rounded-lg border border-primary/40 bg-card/95 shadow-xl backdrop-blur',
        layout ? 'fixed' : cn('max-h-full min-h-0 max-w-[34rem]', minimised ? 'w-auto' : 'w-full'),
      )}
      style={
        layout
          ? {
              left: layout.x,
              top: layout.y,
              width: layout.w,
              // Down to the bottom of the window, but never so short that a
              // card left near the bottom could not hold a step: the clamp
              // below lifts it instead.
              ...(sized && !minimised
                ? { height: layout.h }
                : { maxHeight: `max(min(30rem, 64vh), calc(100vh - ${layout.y}px - 12px))` }),
            }
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
        className={cn(
          'flex cursor-move touch-none select-none items-center gap-2 px-3 py-2',
          !minimised && 'border-b border-border',
        )}
      >
        {header}
      </div>

      <div
        ref={scroller}
        onScroll={measureMore}
        className={cn('min-h-0 overflow-y-auto', sized && 'flex-1', minimised && 'hidden')}
      >
        <div ref={content} className={bodyClassName}>
          {children}
        </div>
      </div>
      {/* The body goes on below its edge: say so, rather than leave a cut-off line to hint it. */}
      {more && !minimised && (
        <div aria-hidden className="pointer-events-none relative h-0">
          <div className="absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-card to-transparent" />
        </div>
      )}

      {!minimised && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">{footer}</div>
      )}

      {!minimised && RESIZE_GRIPS.map(({ edge, className }) => {
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
        className={cn(
          'pointer-events-none absolute bottom-0 right-0 size-3 rounded-br-lg',
          minimised && 'hidden',
        )}
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
