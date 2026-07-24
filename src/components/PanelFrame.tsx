import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { ChevronDown, Dock, PictureInPicture2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDragResize, clampBox } from '@/hooks/useDragResize'
import { loadPanelLayout, savePanelLayout, type PanelBox } from '@/lib/panelLayout'

/** 1rem in CSS px, matching the Tailwind default so rem widths convert cleanly. */
const REM = 16

interface PanelControls {
  collapsed: boolean
  /** Force the panel open — for a header action whose content lives in the body. */
  expand: () => void
}

const PanelControlsContext = createContext<PanelControls | null>(null)

/**
 * Read a panel's controls from within its body or header actions. Lets, say, a
 * Network "About" toggle expand the frame it lives in. Throws outside a
 * PanelFrame so a misplaced consumer fails loudly rather than silently.
 */
export function usePanelControls(): PanelControls {
  const controls = useContext(PanelControlsContext)
  if (!controls) throw new Error('usePanelControls must be used within a PanelFrame')
  return controls
}

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
   * Which edge this panel docks to. Buses live on the left, devices on the
   * right; the value only biases where an undocked card first pops out, since
   * docked alignment is handled by the column it sits in.
   */
  side?: 'left' | 'right'
  /** Inline header status (a link dot, a resolution, …). */
  status?: ReactNode
  /** Extra header buttons, placed before the built-in undock/collapse/close. */
  actions?: ReactNode
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
 */
export function PanelFrame({
  id,
  title,
  icon: Icon,
  defaultExpanded = true,
  dockedWidth = 19,
  side = 'right',
  status,
  actions,
  children,
}: PanelFrameProps) {
  const [saved] = useState(() => loadPanelLayout(id))
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const [floating, setFloating] = useState(saved?.floating ?? false)
  const [rect, setRect] = useState<PanelBox | null>(saved?.rect ?? null)

  const { dragHandlers, resizeHandlers } = useDragResize(rect, setRect)

  // Persist only the floating layout; collapse/dismiss stay session-only.
  useEffect(() => {
    savePanelLayout(id, { floating, rect })
  }, [id, floating, rect])

  const undock = () => {
    // Seed a box from the docked width, popping out near this panel's own edge
    // on first undock, then reuse whatever the user last left. clampBox keeps it
    // on-screen.
    const width = dockedWidth * REM
    const margin = REM
    const seeded: PanelBox = rect ?? {
      x: side === 'left' ? margin : window.innerWidth - width - margin,
      y: window.innerHeight / 3,
      w: width,
      h: 24 * REM,
    }
    setRect(clampBox(seeded))
    setFloating(true)
  }

  const dock = () => setFloating(false)

  const controls = useMemo<PanelControls>(
    () => ({ collapsed, expand: () => setCollapsed(false) }),
    [collapsed],
  )

  if (dismissed) return null

  // A collapsed floating card sizes to its header — keeping height would leave a
  // tall empty box. The stored rect.h is untouched, so expanding restores it.
  const floatingStyle =
    floating && rect
      ? { left: rect.x, top: rect.y, width: rect.w, ...(collapsed ? {} : { height: rect.h }) }
      : undefined

  return (
    <PanelControlsContext.Provider value={controls}>
    <div
      className={cn(
        'pointer-events-auto overflow-hidden rounded-lg border border-border bg-card shadow-lg',
        floating && 'fixed z-40 flex flex-col',
      )}
      style={
        floating
          ? floatingStyle
          : { width: `${dockedWidth}rem`, maxWidth: 'calc(100vw - 2rem)' }
      }
    >
      <div
        {...(floating ? dragHandlers : {})}
        className={cn(
          'flex items-center gap-2 px-3 py-2',
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
            aria-label={floating ? `Dock ${title} panel` : `Undock ${title} panel`}
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
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={`Hide ${title} panel`}
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className={cn(floating && 'min-h-0 flex-1 overflow-auto')}>{children}</div>
      )}

      {/* Corner resize grip — floating only. */}
      {floating && !collapsed && (
        <div
          {...resizeHandlers}
          role="presentation"
          className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
          style={{
            background:
              'linear-gradient(135deg, transparent 0 50%, var(--color-border) 50% 60%, transparent 60% 70%, var(--color-border) 70% 80%, transparent 80%)',
          }}
        />
      )}
    </div>
    </PanelControlsContext.Provider>
  )
}
