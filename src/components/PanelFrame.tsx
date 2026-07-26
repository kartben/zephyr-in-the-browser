import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { ChevronDown, Dock, PictureInPicture2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDragResize, clampBox } from '@/hooks/useDragResize'
import { loadPanelLayout, savePanelLayout, type PanelBox } from '@/lib/panelLayout'

const REM = 16

interface PanelFrameProps {
  id: string
  title: string
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  defaultExpanded?: boolean
  dockedWidth?: number
  side?: 'left' | 'right'
  status?: ReactNode
  actions?: ReactNode
  fill?: boolean
  windowed?: { onClose: () => void }
  children: ReactNode
}

export function PanelFrame({
  id,
  title,
  icon: Icon,
  defaultExpanded = true,
  dockedWidth = 19,
  side = 'right',
  status,
  actions,
  fill = false,
  windowed,
  children,
}: PanelFrameProps) {
  const [saved] = useState(() => loadPanelLayout(id))
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)
  const [floating, setFloating] = useState(windowed ? true : (saved?.floating ?? false))
  const [rect, setRect] = useState<PanelBox | null>(() => {
    if (saved?.rect) return saved.rect
    if (!windowed) return null
    // A controlled window opens floating before it has saved geometry.
    return clampBox(seedBox(dockedWidth, side))
  })

  const { dragHandlers, resizeHandlers } = useDragResize(rect, setRect)

  useEffect(() => {
    savePanelLayout(id, { floating, rect })
  }, [id, floating, rect])

  const undock = () => {
    // First undock seeds near this panel's edge; clampBox keeps it on-screen.
    setRect(clampBox(rect ?? seedBox(dockedWidth, side)))
    setFloating(true)
  }

  const dock = () => (windowed ? windowed.onClose() : setFloating(false))
  const close = () => (windowed ? windowed.onClose() : setDismissed(true))

  if (dismissed) return null

  // Collapsed floating cards keep rect.h saved but size to the header.
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
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={windowed ? `Close ${title} window` : `Hide ${title} panel`}
            onClick={close}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className={cn(floating && 'min-h-0 flex-1 overflow-auto')}>{children}</div>
      )}

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
  )
}

function seedBox(dockedWidth: number, side: 'left' | 'right'): PanelBox {
  const width = dockedWidth * REM
  const margin = REM
  return {
    x: side === 'left' ? margin : window.innerWidth - width - margin,
    y: window.innerHeight / 3,
    w: width,
    h: 24 * REM,
  }
}
