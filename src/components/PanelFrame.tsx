import { useEffect, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, Dock, PictureInPicture2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDragResize, clampBox } from '@/hooks/useDragResize'
import { loadPanelLayout, savePanelLayout, type PanelBox } from '@/lib/panelLayout'

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
   * Fill the parent up to `dockedWidth` — the stage Trace panel used this so a
   * phone got a nearly full-bleed timeline without every dock card stretching.
   * Prefer `dockedResize` when the card should keep a stable, user-sized box.
   */
  fill?: boolean
  /**
   * Let the user resize the card while it stays in the stage stack. `width`
   * exposes an east-edge grip; `both` also locks height (tab switches no longer
   * grow/shrink the chrome) and adds a south-east corner grip. Size persists
   * with the floating `rect`.
   */
  dockedResize?: false | 'width' | 'both'
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
  dockedResize = false,
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
    // Windowed cards and docked-resizable stage cards always own a size box so
    // tab changes cannot grow/shrink the chrome, and undock has something to
    // lift. Other docked panels stay content-sized until first undock.
    if (windowed || dockedResize) return clampBox(seedBox(dockedWidth, seedHeight, side))
    return null
  })

  const sizedDocked = Boolean(dockedResize) && !floating
  const fixedHeight = floating || dockedResize === 'both'

  // Collapsed floaters are header-tall; clamp Y against that so they can sit
  // near the bottom. Full rect.h is preserved for expand. Docked cards only
  // store a size — skip viewport X/Y clamping while they stay in the stack.
  const { dragHandlers, resizeHandlers, resizeXHandlers, resizeYHandlers } = useDragResize(
    rect,
    setRect,
    floating
      ? collapsed
        ? { visibleHeight: FLOATING_HEADER_H }
        : undefined
      : sizedDocked
        ? { sizeOnly: true }
        : undefined,
  )

  // Persist floating + size; collapse/dismiss stay session-only.
  useEffect(() => {
    savePanelLayout(id, { floating, rect })
  }, [id, floating, rect])

  const setCollapsedSafe = (next: boolean | ((c: boolean) => boolean)) => {
    const collapsedNext = typeof next === 'function' ? next(collapsed) : next
    // Expanding after a low drag: push up so the restored body fits.
    if (collapsed && !collapsedNext && rect && floating) {
      setRect(clampBox(rect))
    }
    setCollapsed(collapsedNext)
  }

  const undock = () => {
    // Seed a box from the docked width on first undock; reuse whatever the user
    // last left (including a docked-resizable w/h). clampBox keeps it on-screen.
    setRect(clampBox(rect ?? seedBox(dockedWidth, seedHeight, side)))
    setFloating(true)
  }

  const dock = () => (windowed ? windowed.onClose() : setFloating(false))
  const close = () => (windowed ? windowed.onClose() : setDismissed(true))

  if (dismissed) return null

  // A collapsed floating/sized card sizes to its header — keeping height would
  // leave a tall empty box. The stored rect.h is untouched, so expanding
  // restores it.
  let boxStyle: CSSProperties | undefined
  if (floating && rect) {
    boxStyle = {
      left: rect.x,
      top: rect.y,
      width: rect.w,
      ...(collapsed ? {} : { height: rect.h }),
    }
  } else if (sizedDocked && rect) {
    boxStyle = {
      width: rect.w,
      maxWidth: 'calc(100vw - 2rem)',
      ...(collapsed || dockedResize !== 'both' ? {} : { height: rect.h }),
    }
  } else if (fill) {
    boxStyle = { width: '100%', maxWidth: `${dockedWidth}rem` }
  } else {
    boxStyle = { width: `${dockedWidth}rem`, maxWidth: 'calc(100vw - 2rem)' }
  }

  const showCornerResize = !collapsed && rect && (floating || dockedResize === 'both')
  const showWidthResize = !collapsed && rect && (floating || dockedResize === 'width' || dockedResize === 'both')
  const showHeightResize = !collapsed && rect && (floating || dockedResize === 'both')

  return (
    <div
      data-dock-key={id}
      className={cn(
        'pointer-events-auto relative overflow-hidden rounded-lg border border-border bg-card shadow-lg',
        (floating || fixedHeight) && 'flex flex-col',
        floating && 'fixed z-40',
      )}
      style={boxStyle}
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
          'flex shrink-0 items-center gap-2 px-3 py-2 outline-none',
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
        <div className={cn(fixedHeight && 'min-h-0 flex-1 overflow-auto')}>{children}</div>
      )}

      {/* East-edge width grip — docked Trace/Debug and every floating card. */}
      {showWidthResize && (
        <div
          {...resizeXHandlers}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${title} width`}
          className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize touch-none"
        />
      )}

      {/* South-edge height grip — sized docked cards + floating. */}
      {showHeightResize && (
        <div
          {...resizeYHandlers}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${title} height`}
          className="absolute inset-x-0 bottom-0 z-10 h-1.5 cursor-ns-resize touch-none"
        />
      )}

      {/* Corner resize grip. */}
      {showCornerResize && (
        <div
          {...resizeHandlers}
          role="presentation"
          className="absolute bottom-0 right-0 z-20 size-4 cursor-se-resize touch-none"
          style={{
            background:
              'linear-gradient(135deg, transparent 0 50%, var(--color-border) 50% 60%, transparent 60% 70%, var(--color-border) 70% 80%, transparent 80%)',
          }}
        />
      )}
    </div>
  )
}

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
