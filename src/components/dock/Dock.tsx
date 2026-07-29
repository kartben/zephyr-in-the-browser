/**
 * The device dock: a full-height sidebar that replaced the two floating panel
 * columns. One scrollable body renders the whole device inventory as a flat
 * keyed list in either of two projections — ⌗ nested like the devicetree, ▤
 * grouped by peripheral class — over the *same* row components, so switching
 * views rearranges DOM nodes without remounting a single body.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Boxes, ChevronsRight, FileCode2, ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DtsViewer } from '@/components/DtsViewer'
import { DockDeviceRow, DockGroupRow, DockStructRow } from '@/components/dock/DockRow'
import { DockInstruments } from '@/components/dock/Instruments'
import { GroupBadge } from '@/components/dock/deviceBodies'
import { cn } from '@/lib/utils'
import { buildRowList, type DockView } from '@/deviceTopology'
import { get as getDeviceTree } from '@/devicetree'
import { useDeviceTree } from '@/hooks/useDeviceTree'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  effectiveExpandedIn,
  getState,
  setDrawerOpen,
  setOpen,
  setView,
  setWidth,
  subscribe,
  toggleGroup,
} from '@/lib/dockStore'

const REM = 16
const clampWidth = (w: number) => Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, w))

export function Dock({ boardId }: { boardId: string }) {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const inventory = useDeviceTree(boardId)
  const desktop = useIsDesktop()

  // Width while dragging the left edge is transient; the store (and storage)
  // only hear about it on release, so a drag is not a localStorage firehose.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragging = useRef(false)
  const latestDragWidth = useRef(0)
  const width = dragWidth ?? state.width

  // Row list depends on inventory + dock layout, not on the transient drag
  // width — keep it memoized so resizing the sidebar does not rebuild JSX.
  const rendered = useMemo(() => {
    if (!state.open && !state.drawerOpen) return null as ReactNode[] | null
    const rows = buildRowList(inventory, state.view)
    const hidden = new Set(
      Object.entries(state.devices)
        .filter(([, v]) => v.hidden)
        .map(([key]) => key),
    )

    const next: ReactNode[] = []
    let collapsedClass: string | null = null
    for (const row of rows) {
      if (row.kind === 'group') {
        const collapsed = state.groups[row.deviceClass]?.collapsed ?? false
        collapsedClass = collapsed ? row.deviceClass : null
        next.push(
          <DockGroupRow
            key={row.key}
            label={row.label}
            count={row.count}
            collapsed={collapsed}
            onToggle={() => toggleGroup(row.deviceClass)}
            badge={
              collapsed ? (
                <GroupBadge
                  deviceClass={row.deviceClass}
                  nodes={inventory.nodes.filter((n) => n.deviceClass === row.deviceClass)}
                />
              ) : undefined
            }
          />,
        )
        continue
      }
      if (row.kind === 'struct') {
        next.push(<DockStructRow key={row.key} name={row.name} depth={row.depth} note={row.note} />)
        continue
      }
      const node = row.node
      if (state.view === 'classes' && collapsedClass === node.deviceClass) continue
      if (hidden.has(node.key) || (node.parentKey && hidden.has(node.parentKey))) continue
      next.push(
        <DockDeviceRow
          key={node.key}
          node={node}
          depth={row.depth}
          view={state.view}
          windowed={state.devices[node.key]?.windowed === true}
          expanded={effectiveExpandedIn(state, node.key, node.panelKind)}
        />,
      )
    }
    return next
  }, [inventory, state.open, state.drawerOpen, state.view, state.devices, state.groups])

  // Two different things share one sidebar: a persistent desktop column, and a
  // drawer that covers the stage on a phone and so starts closed every visit.
  const visible = desktop ? state.open : state.drawerOpen
  const hide = () => (desktop ? setOpen(false) : setDrawerOpen(false))
  if (!visible) return null

  return (
    <>
      {/*
        Narrow viewports: the dock floats over the stage instead of taking a
        column out of it. A 21rem sidebar on a 375px phone left the terminal
        about eighty pixels wide — one character per line. Tapping the scrim
        closes it, the way a drawer should.
      */}
      {!desktop && (
        <div
          className="fixed inset-0 z-30 bg-background/70 backdrop-blur-[1px]"
          onClick={hide}
          aria-hidden
        />
      )}
      <aside
        aria-label="Devices"
        className={cn(
          'flex flex-col border-l border-border bg-card',
          desktop
            ? 'relative h-full shrink-0'
            : 'fixed inset-y-0 right-0 z-40 w-[min(22rem,88vw)] shadow-2xl',
        )}
        style={desktop ? { width: `${width}rem` } : undefined}
      >
        {/* Left-edge width handle — a pointer affordance, so desktop only. */}
        {desktop && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the device dock"
            className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-primary/30"
            onPointerDown={(e) => {
              dragging.current = true
              latestDragWidth.current = state.width
              setDragWidth(state.width)
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (!dragging.current) return
              const next = clampWidth((window.innerWidth - e.clientX) / REM)
              latestDragWidth.current = next
              setDragWidth(next)
            }}
            onPointerUp={() => {
              if (!dragging.current) return
              dragging.current = false
              setWidth(latestDragWidth.current)
              setDragWidth(null)
            }}
            onPointerCancel={() => {
              dragging.current = false
              setDragWidth(null)
            }}
          />
        )}

        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
          <ViewSwitch view={state.view} />
          <span className="ml-auto flex items-center gap-0.5">
            <RunningTreeButton />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Collapse the device dock"
              title="Collapse the dock (reopen from the top bar)"
              onClick={hide}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          <SectionHeading>Instruments</SectionHeading>
          <DockInstruments />
          <SectionHeading>Devices</SectionHeading>
          {inventory.nodes.length === 0 ? (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
              No peripherals yet. Waiting for the emulator to boot.
            </p>
          ) : (
            rendered
          )}
        </div>
      </aside>
    </>
  )
}

/** Separates the machine's instruments from the guest's own devices. */
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-1.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 first:pt-0.5">
      {children}
    </p>
  )
}

/** ⌗ / ▤ — two arrangements of the same rows. */
function ViewSwitch({ view }: { view: DockView }) {
  return (
    <span className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Dock view">
      <ViewButton active={view === 'classes'} onClick={() => setView('classes')} label="Peripheral classes">
        <Boxes className="size-3" aria-hidden />
        Classes
      </ViewButton>
      <ViewButton active={view === 'devicetree'} onClick={() => setView('devicetree')} label="Devicetree">
        <ListTree className="size-3" aria-hidden />
        Tree
      </ViewButton>
    </span>
  )
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-1.5 py-0.5 text-[10px]',
        active ? 'bg-primary/15 font-semibold text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Opens the running build's devicetree in the full-fidelity viewer. */
function RunningTreeButton() {
  const [open, setDialogOpen] = useState(false)
  const load = useCallback(() => Promise.resolve(getDeviceTree()?.text ?? null), [])
  const tree = getDeviceTree()
  if (!tree) return null
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="View the full devicetree"
        title={`Devicetree: ${tree.name}`}
        onClick={() => setDialogOpen(true)}
      >
        <FileCode2 className="size-3.5" />
      </Button>
      <DtsViewer
        open={open}
        onOpenChange={setDialogOpen}
        title={`${tree.name} · running build`}
        load={load}
      />
    </>
  )
}
