import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { ChevronDown, Dock, PictureInPicture2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDragResize, clampBox, type ResizeEdge } from '@/hooks/useDragResize'
import {
  loadPanelLayout,
  savePanelLayout,
  type PanelBox,
  type PanelLayout,
} from '@/lib/panelLayout'

/** 1rem in CSS px, matching the Tailwind default so rem widths convert cleanly. */
const REM = 16
/** Approx. height of a collapsed floating header (py-2 + controls). */
const FLOATING_HEADER_H = 40

interface PanelFrameProps {
  /**
   * Stable key for persisting this panel's floating layout. A PanelKind for the
   * fixed bridges; a per-instance key (e.g. `sensor:48`) for panels that can
   * appear more than once, so their layouts do not collide.
   */
  id: string
  /** Header title. */
  title: string
  /** Header icon (a lucide component). */
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  /** Expanded on mount unless the user has collapsed it this session. */
  defaultExpanded?: boolean
  /** Docked card width, in rem. The floating card seeds its size from this. */
  dockedWidth?: number
  /**
   * First-pop-out height, in rem. Hex/flash windows carry a sector map plus
   * the dump — the default 24 rem clips the bottom of that stack.
   */
  seedHeight?: number
  /**
   * Which edge this panel docks to. Buses live on the left, devices on the
   * right; the value only biases where an undocked card first pops out, since
   * docked alignment is handled by the column it sits in.
   */
  side?: 'left' | 'right'
  /** Inline header status (a link dot, a resolution, …). */
  status?: ReactNode
  /** Extra header buttons, placed before the built-in undock/collapse/close. */
  actions?: ReactNode
  /**
   * Fill the parent up to `dockedWidth`, rather than sizing to it.
   */
  fill?: boolean
  /**
   * Controlled window mode, for bodies whose home is the dock: the frame is
   * always floating, and both the dock button and the X hand control back to
   * the caller (returning the body to its dock row) instead of self-managing.
   */
  windowed?: { onClose: () => void }
  /**
   * Show the header close (X) control. Debug keeps run-control visible for the
   * session — hide via the Panels menu instead of dismissing the card.
   */
  dismissible?: boolean
  /** Panel body — rendered only while expanded. */
  children: ReactNode
}

/**
 * The shared shell for every peripheral panel: the card, the header (icon,
 * title, status, controls), and the collapse / undock / dismiss behaviour that
 * used to be copy-pasted into all seven of them.
 *
 * A panel is either *docked* — in the bottom-right stack, sized by dockedWidth
 * — or *floating*: the same card lifted out with `position: fixed`, dragged by
 * its header and resized from the corner. Floating position and size persist
 * across reloads (src/lib/panelLayout.ts); collapse and dismissal are
 * session-only so the running sample keeps driving which panels open expanded.
 * Double-clicking the header collapses or expands the body (docked or floating).
 */
export function PanelFrame({
  id,
  title,
  icon: Icon,
  defaultExpanded = true,
  dockedWidth = 19,
  seedHeight = 24,
  side = 'right',
  status,
  actions,
  fill = false,
  windowed,
  dismissible = true,
  children,
}: PanelFrameProps) {
  const [saved] = useState(() => loadPanelLayout(id))
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const [floating, setFloating] = useState(windowed ? true : (saved?.floating ?? false))
  const [rect, setRect] = useState<PanelBox | null>(() => {
    if (saved?.rect) return saved.rect
    if (!windowed) return null
    // A window opens floating with nothing saved yet: seed its box now, the
    // same math undock() uses on first pop-out.
    return clampBox(seedBox(dockedWidth, seedHeight, side))
  })

  // Collapsed floaters are header-tall; clamp Y against that so they can sit
  // near the bottom. Full rect.h is preserved for expand.
  const { dragHandlers, resizeHandlers } = useDragResize(
    rect,
    setRect,
    collapsed ? { visibleHeight: FLOATING_HEADER_H } : undefined,
  )

  /*
   * Persist only the floating layout; collapse/dismiss stay session-only.
   *
   * Debounced because `rect` changes on every pointermove of a drag or resize,
   * and localStorage.setItem is a synchronous, disk-backed write — persisting
   * inline put one of those in the middle of every dragged frame. The dock's
   * own width handle avoids this by only telling its store on release; a panel
   * has no single release point (the window-resize clamp moves it too), so it
   * debounces and flushes on unmount instead — closing a window right after
   * nudging it must not throw the nudge away.
   */
  const pendingLayout = useRef<PanelLayout>({ floating, rect })
  pendingLayout.current = { floating, rect }
  useEffect(() => {
    const handle = setTimeout(() => savePanelLayout(id, pendingLayout.current), 150)
    return () => clearTimeout(handle)
  }, [id, floating, rect])
  useEffect(() => () => savePanelLayout(id, pendingLayout.current), [id])

  const setCollapsedSafe = (next: boolean | ((c: boolean) => boolean)) => {
    const collapsedNext = typeof next === 'function' ? next(collapsed) : next
    // Expanding after a low drag: push up so the restored body fits.
    if (collapsed && !collapsedNext && rect) {
      setRect(clampBox(rect))
    }
    setCollapsed(collapsedNext)
  }

  const undock = () => {
    // Seed a box from the docked width, popping out near this panel's own edge
    // on first undock, then reuse whatever the user last left. clampBox keeps it
    // on-screen.
    setRect(clampBox(rect ?? seedBox(dockedWidth, seedHeight, side)))
    setFloating(true)
  }

  const dock = () => (windowed ? windowed.onClose() : setFloating(false))
  const close = () => (windowed ? windowed.onClose() : setDismissed(true))

  if (dismissed) return null

  // A collapsed floating card sizes to its header — keeping height would leave a
  // tall empty box. The stored rect.h is untouched, so expanding restores it.
  const floatingStyle =
    floating && rect
      ? { left: rect.x, top: rect.y, width: rect.w, ...(collapsed ? {} : { height: rect.h }) }
      : undefined

  return (
    <div
      data-dock-key={id}
      className={cn(
        'pointer-events-auto overflow-hidden rounded-lg border border-border bg-card shadow-lg',
        floating && 'fixed z-40 flex flex-col',
      )}
      style={
        floating
          ? floatingStyle
          : fill
            ? { width: '100%', maxWidth: `${dockedWidth}rem` }
            : { width: `${dockedWidth}rem`, maxWidth: 'calc(100vw - 2rem)' }
      }
    >
      <div
        data-dock-focus
        tabIndex={-1}
        {...(floating ? dragHandlers : {})}
        onDoubleClick={(event) => {
          // Title-bar double-click toggles collapse (docked or floating).
          if (event.target instanceof Element && event.target.closest('button')) return
          setCollapsedSafe((c) => !c)
        }}
        className={cn(
          'flex items-center gap-2 px-3 py-2 outline-none',
          !collapsed && 'border-b border-border',
          floating && 'cursor-move touch-none select-none',
        )}
      >
        <Icon className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">{title}</span>
        {status}
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={
              windowed
                ? `Return ${title} to the dock`
                : floating
                  ? `Dock ${title} panel`
                  : `Undock ${title} panel`
            }
            aria-pressed={floating}
            onClick={floating ? dock : undock}
          >
            {floating ? <Dock className="size-3.5" /> : <PictureInPicture2 className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? `Expand ${title} panel` : `Collapse ${title} panel`}
            aria-expanded={!collapsed}
            onClick={() => setCollapsedSafe((c) => !c)}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
          </Button>
          {dismissible && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={windowed ? `Close ${title} window` : `Hide ${title} panel`}
              onClick={close}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className={cn(floating && 'min-h-0 flex-1 overflow-auto')}>{children}</div>
      )}

      {/* Resize grips — floating only, on every edge and corner. */}
      {floating && !collapsed && (
        <>
          {RESIZE_GRIPS.map(({ edge, className }) => (
            <div
              key={edge}
              {...resizeHandlers(edge)}
              role="presentation"
              aria-hidden
              className={cn('absolute touch-none', className)}
            />
          ))}
          {/* The bottom-right corner keeps its visible hatch: it is the one
              people look for, and an invisible grip is not an affordance. */}
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-0 right-0 size-4"
            style={{
              background:
                'linear-gradient(135deg, transparent 0 50%, var(--color-border) 50% 60%, transparent 60% 70%, var(--color-border) 70% 80%, transparent 80%)',
            }}
          />
        </>
      )}
    </div>
  )
}

/**
 * Hit areas for the eight resize grips.
 *
 * They sit *inside* the frame — the card clips its overflow, so an overhanging
 * grip would simply not be there — and stay narrow enough that the header drag
 * and the body's own controls keep the rest of the edge. Corners come last in
 * DOM order so they win where they overlap an edge.
 */
const RESIZE_GRIPS: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: 'n', className: 'top-0 left-3.5 right-3.5 h-2 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-3.5 right-3.5 h-2 cursor-ns-resize' },
  { edge: 'w', className: 'left-0 top-3.5 bottom-3.5 w-2 cursor-ew-resize' },
  { edge: 'e', className: 'right-0 top-3.5 bottom-3.5 w-2 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 size-3.5 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 size-3.5 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 size-3.5 cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 size-4 cursor-nwse-resize' },
]

/** First-pop-out box: docked width, hugging the panel's edge, high enough to clear the chrome. */
function seedBox(dockedWidth: number, seedHeight: number, side: 'left' | 'right'): PanelBox {
  const width = dockedWidth * REM
  const height = seedHeight * REM
  const margin = REM
  // Prefer sitting near the top so a taller seed still leaves the bottom in view.
  const y = Math.max(margin, Math.min(window.innerHeight / 8, window.innerHeight - height - margin))
  return {
    x: side === 'left' ? margin : window.innerWidth - width - margin,
    y,
    w: width,
    h: height,
  }
}
