/**
 * One row of the dock, in either view: a header line (indent guides, icon,
 * name, live badge, pop-out control) and — for interactive rows — the device's
 * body, expanded in place. Inert rows document topology (`in the terminal`);
 * ghost rows document absence (a declared chip nothing answers for).
 *
 * Rows are rendered as one flat keyed list under a single parent, so flipping
 * the dock's view moves these nodes instead of remounting them — sliders,
 * scroll positions and the OLED canvas all survive. Nesting is data (`depth`),
 * never wrapper elements.
 */

import { memo, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronRight, Dock as DockIcon, PictureInPicture2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DeviceBadge, DeviceBody, deviceIcon } from '@/components/dock/deviceBodies'
import { cn } from '@/lib/utils'
import type { DeviceClass, DeviceNode, DockView } from '@/deviceTopology'
import { setExpanded, setSoloExpanded, setWindowed } from '@/lib/dockStore'
import { isDockTargetRow, subscribe as subscribeTarget } from '@/lib/dockTarget'

/**
 * Secondary text beside the row's primary name.
 *
 * Classes view: bus breadcrumb (`I²C · 0x48`). Virtio controller labels stay
 * on the tooltip and in the device-tree view's node names.
 * Device-tree view: the friendly label beside the DT node name. Compatible
 * strings used to sit here too, but PartIdentityStrip already shows them on
 * expanded chip bodies — repeating `ti,tmp112` on every ⌗ row was noise and
 * doubled up the moment a part opened. Catalogued parts (`partId`) therefore
 * leave compatible off the row; uncatalogued / inert nodes still show it when
 * there is no better label. A label that only says the node name again, in
 * other capitals ("LEDs" on `leds`), is not a better one: the row shows
 * `gpio-leds` instead.
 */
export function dockRowSecondary(node: DeviceNode, view: DockView): string | undefined {
  if (view === 'classes') return node.crumb
  if (node.label && distinctSecondary(node.nodeName, node.label)) return node.label
  if (node.partId) return undefined
  if (node.compatible && node.compatible !== node.nodeName) return node.compatible
  return undefined
}

/**
 * The secondary text worth showing beside a row's name: none when it only
 * says the name again. A NIC whose devicetree label is "network" read
 * "Network Network" under a NETWORK heading. Compared ignoring case and
 * spacing, and only when both are plain text.
 */
export function distinctSecondary(name: ReactNode, secondary: ReactNode): ReactNode {
  if (typeof name !== 'string' || typeof secondary !== 'string') return secondary
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(name) === norm(secondary) ? undefined : secondary
}

/** Tooltip for a device row: node name, label, and virtio bus when soft-named. */
export function dockRowTitle(node: DeviceNode): string {
  const parts = [node.nodeName, node.label]
  if (node.busLabel && node.busLabel !== node.label && !parts.includes(node.busLabel)) {
    parts.push(node.busLabel)
  }
  return parts.join(' · ')
}

/** Indent guides: one thin rule per ancestor level, echoing a tree gutter. */
function Guides({ depth }: { depth: number }) {
  if (depth === 0) return null
  return (
    <span aria-hidden className="flex self-stretch">
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="ml-1.5 w-2 border-l border-border/60" />
      ))}
    </span>
  )
}

export interface DockRowShellProps {
  /** Row identity for reveal/scroll-into-view and float geometry. */
  dockKey: string
  icon: LucideIcon
  /** Primary label. */
  name: ReactNode
  /** Tooltip on the label. */
  nameTitle?: string
  nameClassName?: string
  /** Dim secondary text after the name; hidden on very narrow docks. */
  secondary?: ReactNode
  /** Right-edge live summary, so collapsed never means blind. */
  badge?: ReactNode
  /**
   * The body shows the badge's value itself, larger (a device's reading, its
   * IP, the clock), so the badge steps aside while the body is open rather
   * than say it twice. Instruments leave it off: Trace's event count and
   * Debug's stop location are not in their bodies.
   */
  bodyRepeatsBadge?: boolean
  /** Small qualifier chip after the name ('not in devicetree'). */
  tag?: ReactNode
  depth?: number
  /** False for rows that only document topology — no chevron, no body. */
  interactive?: boolean
  expanded: boolean
  onToggle: () => void
  /** Undefined for rows that cannot pop out. */
  windowed?: boolean
  onWindowedChange?: (next: boolean) => void
  /** Name used in the pop-out control's labels. */
  windowLabel?: string
  className?: string
  /** Body, rendered only while expanded. */
  children?: ReactNode
}

/**
 * The row chrome every dock entry wears: indent guides, icon, name, live badge
 * and the pop-out control, over a body that expands in place. Devices and
 * instruments (Trace, Debug, Simulation) share it so a debugger behaves exactly
 * like a sensor — expand, collapse, pop out, dock again.
 */
export function DockRowShell({
  dockKey,
  icon: Icon,
  name,
  nameTitle,
  nameClassName,
  secondary,
  badge,
  bodyRepeatsBadge = false,
  tag,
  depth = 0,
  interactive = true,
  expanded,
  onToggle,
  windowed,
  onWindowedChange,
  windowLabel,
  className,
  children,
}: DockRowShellProps) {
  const canPopOut = onWindowedChange !== undefined && interactive
  const isWindowed = windowed === true
  const showBody = interactive && !isWindowed && expanded
  const shownSecondary = distinctSecondary(name, secondary)
  // The tour card on screen is about this row: see lib/dockTarget.ts.
  const isTarget = () => isDockTargetRow(dockKey)
  const targeted = useSyncExternalStore(subscribeTarget, isTarget, isTarget)

  return (
    <div data-dock-key={dockKey} className={cn(className, targeted && 'dock-row-target')}>
      <div className="group flex min-h-7 items-center gap-1 pr-1.5">
        <Guides depth={depth} />
        <button
          type="button"
          data-dock-focus
          disabled={!interactive || isWindowed}
          aria-expanded={interactive ? showBody : undefined}
          onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1 text-left',
            interactive && !isWindowed && 'hover:bg-secondary/60',
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3 shrink-0 text-muted-foreground/70 transition-transform',
              showBody && 'rotate-90',
              (!interactive || isWindowed) && 'invisible',
            )}
          />
          <Icon
            aria-hidden
            className={cn('size-3.5 shrink-0', interactive ? 'text-primary' : 'text-muted-foreground')}
          />
          <span className={cn('truncate text-xs', nameClassName)} title={nameTitle}>
            {name}
          </span>
          {shownSecondary && (
            <span className="hidden min-w-0 truncate font-mono text-[10px] leading-none text-muted-foreground/80 sm:inline">
              {shownSecondary}
            </span>
          )}
          {tag}
        </button>

        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
          {!(bodyRepeatsBadge && showBody) && badge}
          {canPopOut && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'size-5 text-muted-foreground',
                !isWindowed &&
                  'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
                isWindowed && 'text-primary',
              )}
              aria-label={
                isWindowed
                  ? `Return ${windowLabel} to the dock`
                  : `Open ${windowLabel} in a window`
              }
              aria-pressed={isWindowed}
              title={isWindowed ? 'In a window: return to the dock' : 'Open in a floating window'}
              onClick={() => onWindowedChange(!isWindowed)}
            >
              {isWindowed ? <DockIcon className="size-3" /> : <PictureInPicture2 className="size-3" />}
            </Button>
          )}
        </span>
      </div>

      {showBody && (
        <div className="flex">
          <Guides depth={depth + 1} />
          <div className="min-w-0 flex-1 border-b border-border/50">{children}</div>
        </div>
      )}
    </div>
  )
}

export const DockDeviceRow = memo(function DockDeviceRow({
  node,
  depth,
  view,
  windowed,
  expanded: expandedChoice,
  soloClass,
}: {
  node: DeviceNode
  depth: number
  view: DockView
  windowed: boolean
  /** The store's effective expansion; the row itself decides if a body shows. */
  expanded: boolean
  /** Set when the row stands alone for its class, with no group header above it. */
  soloClass?: DeviceClass
}) {
  const interactive = node.presence === 'interactive'

  return (
    <DockRowShell
      dockKey={node.key}
      className={cn(node.presence === 'ghost' && 'opacity-70')}
      icon={deviceIcon(node)}
      name={view === 'devicetree' ? node.nodeName : node.label}
      nameTitle={dockRowTitle(node)}
      nameClassName={cn(
        view === 'devicetree' ? 'font-mono' : 'font-medium',
        !interactive && 'text-muted-foreground',
        node.presence === 'ghost' && 'line-through decoration-border',
      )}
      secondary={dockRowSecondary(node, view)}
      tag={
        node.tag ? (
          <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] leading-tight text-muted-foreground">
            {node.tag}
          </span>
        ) : undefined
      }
      badge={
        node.note ? (
          <span
            title={node.noteTitle}
            className={cn(
              'font-mono text-[10px]',
              node.presence === 'ghost' ? 'text-destructive/80' : 'text-muted-foreground',
            )}
          >
            {node.note}
          </span>
        ) : (
          <DeviceBadge node={node} />
        )
      }
      // A note qualifies the row ('not answering'); a live badge is the value
      // the open body shows larger.
      bodyRepeatsBadge={!node.note}
      depth={depth}
      interactive={interactive}
      expanded={expandedChoice}
      onToggle={() =>
        soloClass
          ? setSoloExpanded(node.key, soloClass, !expandedChoice)
          : setExpanded(node.key, !expandedChoice)
      }
      windowed={windowed}
      onWindowedChange={(next) => setWindowed(node.key, next)}
      windowLabel={node.label}
    >
      <DeviceBody node={node} />
    </DockRowShell>
  )
})

export function DockStructRow({
  name,
  depth,
  note,
}: {
  name: string
  depth: number
  note?: string
}) {
  return (
    <div className="flex min-h-6 items-center gap-1 pr-2">
      <Guides depth={depth} />
      <span className="pl-1 font-mono text-[11px] text-muted-foreground/80">{name}</span>
      {note && (
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/60">
          {note}
        </span>
      )}
    </div>
  )
}

/**
 * The ▤ view's last row: "More on this board", folding away every device the
 * running sample is not about (lib/dockSections). A disclosure rather than a
 * heading, and in sentence case, so it does not read as a third level over
 * the class groups inside it.
 */
export function DockFoldRow({
  label,
  count,
  open,
  onToggle,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="mt-2 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left first:mt-0 hover:bg-secondary/60"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3 shrink-0 text-muted-foreground transition-transform',
          open && 'rotate-90',
        )}
      />
      <span className="text-[11px] font-medium text-muted-foreground">
        {label} <span className="tabular-nums">({count})</span>
      </span>
    </button>
  )
}

export function DockGroupRow({
  label,
  count,
  collapsed,
  onToggle,
  badge,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  /** Live summary shown while collapsed, so folding a group isn't going blind. */
  badge?: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left first:mt-0 hover:bg-secondary/60"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3 shrink-0 text-muted-foreground/70 transition-transform',
          !collapsed && 'rotate-90',
        )}
      />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
      {badge && <span className="ml-auto flex min-w-0 items-center pl-2">{badge}</span>}
    </button>
  )
}
