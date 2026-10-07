/**
 * The device dock: a full-height sidebar that replaced the two floating panel
 * columns. One scrollable body renders the whole device inventory as a flat
 * keyed list in either of two projections — ⌗ nested like the devicetree, ▤
 * grouped by peripheral class — over the *same* row components, so switching
 * views rearranges DOM nodes without remounting a single body. The instrument
 * rows are in that list too: the ▤ view puts the sample's own rows first
 * (lib/dockSections), Trace among them when the sample names it.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Boxes, ChevronsLeft, ChevronsRight, FileCode2, ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DtsViewer } from '@/components/DtsViewer'
import {
  DockDeviceRow,
  DockFoldRow,
  DockGroupRow,
  DockStructRow,
} from '@/components/dock/DockRow'
import { InstrumentRow, useInstrumentRows } from '@/components/dock/Instruments'
import { GroupBadge } from '@/components/dock/deviceBodies'
import { cn } from '@/lib/utils'
import {
  buildRowList,
  demoVisibleNodes,
  flattenSoloGroups,
  usableNodes,
  type DeviceNode,
  type DockView,
  type Row,
} from '@/deviceTopology'
import { sampleFirst } from '@/lib/dockSections'
import { get as getDeviceTree } from '@/devicetree'
import { getMode, subscribe as subscribeMode } from '@/lib/modeStore'
import { useDeviceTree } from '@/hooks/useDeviceTree'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  effectiveExpandedIn,
  getState,
  groupCollapsedIn,
  leadExpandedIn,
  moreOpenIn,
  setDrawerOpen,
  setGroupCollapsed,
  setMoreOpen,
  setOpen,
  setView,
  setWidth,
  soloExpandedIn,
  subscribe,
} from '@/lib/dockStore'

const REM = 16
const clampWidth = (w: number) => Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, w))

export function Dock({ boardId, demo = false }: { boardId: string; demo?: boolean }) {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const fullInventory = useDeviceTree(boardId)
  const { inventory, hiddenInert } = useMemo(() => {
    if (!demo) return { inventory: fullInventory, hiddenInert: 0 }
    const visible = demoVisibleNodes(fullInventory.nodes)
    return {
      inventory: { ...fullInventory, nodes: visible.nodes },
      hiddenInert: visible.hidden,
    }
  }, [demo, fullInventory])
  // The ▤ view lists what there is to use (deviceTopology's usableNodes); the
  // ⌗ view, where the devicetree is learnt, keeps every node. `leftOut` is the
  // difference, which the view owns up to on its last line.
  const listed = useMemo(() => {
    if (state.view !== 'classes') return { inventory, leftOut: 0 }
    const usable = usableNodes(inventory.nodes, state.seed.primary)
    return { inventory: { ...inventory, nodes: usable.nodes }, leftOut: usable.hidden }
  }, [inventory, state.view, state.seed.primary])
  const desktop = useIsDesktop()
  const mode = useSyncExternalStore(subscribeMode, getMode, getMode)

  // Width while dragging the left edge is transient; the store (and storage)
  // only hear about it on release, so a drag is not a localStorage firehose.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragging = useRef(false)
  const latestDragWidth = useRef(0)
  const width = dragWidth ?? state.width

  const instruments = useInstrumentRows()

  // Row list depends on inventory + dock layout, not on the transient drag
  // width — keep it memoized so resizing the sidebar does not rebuild JSX.
  const rendered = useMemo(() => {
    if (!state.open && !state.drawerOpen) return null as ReactNode[] | null
    const hidden = new Set(
      Object.entries(state.devices)
        .filter(([, v]) => v.hidden)
        .map(([key]) => key),
    )
    const shown = instruments.filter((row) => row.shown)
    const next: ReactNode[] = []

    const pushInstrument = (key: string) => {
      const row = shown.find((r) => r.instrument.key === key)
      if (!row) return
      next.push(
        <InstrumentRow
          key={key}
          instrument={row.instrument}
          windowed={row.windowed}
          expanded={row.expanded}
        />,
      )
    }

    // Device rows under their class headers (▤) or their tree scaffolding (⌗).
    const pushRows = (rows: readonly Row[], view: DockView) => {
      let collapsedClass: string | null = null
      rows.forEach((row, i) => {
        if (row.kind === 'group') {
          // The devices under this header: in the fold, only the ones the
          // sample did not take to the top, so its badge and default fold
          // speak for what the group holds.
          const members: DeviceNode[] = []
          for (const r of rows.slice(i + 1)) {
            if (r.kind !== 'device' || r.node.deviceClass !== row.deviceClass) break
            members.push(r.node)
          }
          const collapsed = groupCollapsedIn(
            state,
            row.deviceClass,
            members.map((n) => n.panelKind),
          )
          collapsedClass = collapsed ? row.deviceClass : null
          next.push(
            <DockGroupRow
              key={row.key}
              label={row.label}
              count={row.count}
              collapsed={collapsed}
              onToggle={() => setGroupCollapsed(row.deviceClass, !collapsed)}
              badge={
                collapsed ? <GroupBadge deviceClass={row.deviceClass} nodes={members} /> : undefined
              }
            />,
          )
          return
        }
        if (row.kind === 'struct') {
          next.push(<DockStructRow key={row.key} name={row.name} depth={row.depth} note={row.note} />)
          return
        }
        const node = row.node
        if (view === 'classes' && collapsedClass === node.deviceClass) return
        if (hidden.has(node.key) || (node.parentKey && hidden.has(node.parentKey))) return
        next.push(
          <DockDeviceRow
            key={node.key}
            node={node}
            depth={row.depth}
            view={view}
            windowed={state.devices[node.key]?.windowed === true}
            expanded={
              row.solo
                ? soloExpandedIn(state, node.key, node.deviceClass, node.panelKind)
                : effectiveExpandedIn(state, node.key, node.panelKind)
            }
            soloClass={row.solo ? node.deviceClass : undefined}
          />,
        )
      })
    }

    // ▤ with a guest: the sample's rows, the other instruments, then the fold,
    // all from the rows there is something to use on (usableNodes); the rest
    // are counted on a last line that leads to the devicetree view.
    if (mode === 'sim' && state.view === 'classes' && inventory.nodes.length > 0) {
      const layout = sampleFirst(
        buildRowList(listed.inventory, 'classes'),
        state.seed.primary,
        shown.map((row) => ({ key: row.instrument.key, panelKind: row.instrument.panelKind })),
      )
      for (const row of layout.lead) {
        if (row.kind === 'instrument') {
          pushInstrument(row.key)
          continue
        }
        const node = row.node
        if (hidden.has(node.key) || (node.parentKey && hidden.has(node.parentKey))) continue
        next.push(
          <DockDeviceRow
            key={node.key}
            node={node}
            depth={row.depth}
            view="classes"
            windowed={state.devices[node.key]?.windowed === true}
            expanded={leadExpandedIn(state, node.key, node.panelKind)}
          />,
        )
      }
      if (layout.instruments.length > 0) {
        next.push(<SectionHeading key="heading:instruments">Instruments</SectionHeading>)
        for (const key of layout.instruments) pushInstrument(key)
      }
      if (layout.moreCount > 0) {
        const open = moreOpenIn(state)
        next.push(
          <DockFoldRow
            key="fold:more"
            label="More on this board"
            count={layout.moreCount}
            open={open}
            onToggle={() => setMoreOpen(!open)}
          />,
        )
        // A class left with one part in the fold loses its header there too.
        if (open) pushRows(flattenSoloGroups([...layout.more]), 'classes')
      }
      // Only while nothing at all is up: a sample whose one thing to use is
      // an instrument (tracing_pipeline's Trace) has nothing missing.
      if (listed.inventory.nodes.length === 0 && layout.lead.length === 0) {
        next.push(
          <p key="nothing" className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
            Nothing here to use yet.
          </p>,
        )
      }
      if (listed.leftOut > 0) {
        next.push(
          <LeftOutLine
            key="left-out"
            count={listed.leftOut}
            more={listed.inventory.nodes.length > 0}
          />,
        )
      }
      return next
    }

    // ⌗, a guest still booting, or a Live board with no guest at all: the
    // instruments, then the devices in the view's own order.
    if (shown.length > 0) {
      next.push(<SectionHeading key="heading:instruments">Instruments</SectionHeading>)
      for (const row of shown) pushInstrument(row.instrument.key)
    }
    // Devices come from the guest's devicetree; a Live board session has no
    // guest, and "waiting for the guest to boot" would be a lie.
    if (mode !== 'sim') return next
    next.push(<SectionHeading key="heading:devices">Devices</SectionHeading>)
    if (inventory.nodes.length === 0) {
      next.push(
        <p key="empty" className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
          No peripherals yet. Waiting for the guest to boot.
        </p>,
      )
      return next
    }
    pushRows(buildRowList(inventory, state.view), state.view)
    return next
  }, [
    inventory,
    listed,
    instruments,
    mode,
    state.open,
    state.drawerOpen,
    state.view,
    state.devices,
    state.groups,
    state.seed,
    state.moreOpen,
  ])

  // Two different things share one sidebar: a persistent desktop column, and a
  // drawer that covers the stage on a phone and so starts closed every visit.
  const visible = desktop ? state.open : state.drawerOpen
  const hide = () => (desktop ? setOpen(false) : setDrawerOpen(false))

  // Desktop: leave a slim edge tab so collapse is not a one-way door. Narrow:
  // the top-bar DockToggle opens the overlay drawer (no room for a strip).
  if (!visible) {
    if (!desktop) return null
    return <DockCollapsedTab onOpen={() => setOpen(true)} />
  }

  return (
    <>
      {/*
        Narrow viewports: the dock floats over the stage instead of taking a
        column out of it. A 21rem sidebar on a 375px phone left the terminal
        about eighty pixels wide — one character per line. The drawer and its
        scrim start below the top bar (h-14) so Help, Settings, and More stay
        clickable; tapping the dimmed stage dismisses the drawer.
      */}
      {!desktop && (
        <div
          className="fixed inset-x-0 bottom-0 top-14 z-30 bg-black/45"
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
            : 'fixed bottom-0 right-0 top-14 z-40 w-[min(22rem,88vw)] shadow-2xl',
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
          {/* The view switch rearranges device rows; a Live board session has none. */}
          {mode === 'sim' && <ViewSwitch view={state.view} />}
          <span className="ml-auto flex items-center gap-0.5">
            <RunningTreeButton />
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Collapse the device dock"
              title="Collapse the device dock"
              onClick={hide}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {rendered}
          {mode === 'sim' && demo && hiddenInert > 0 && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-muted-foreground">
              Other peripherals appear when a Zephyr app is running.
            </p>
          )}
        </div>
      </aside>
    </>
  )
}

/** Slim right-edge control: collapse is reversible without the top bar. */
function DockCollapsedTab({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Show the device dock"
      title="Show the device dock"
      onClick={onOpen}
      className={cn(
        'flex h-full w-7 shrink-0 flex-col items-center justify-center',
        'border-l border-border bg-card text-muted-foreground',
        'transition-colors hover:bg-secondary hover:text-foreground',
      )}
    >
      <ChevronsLeft className="size-3.5" aria-hidden />
    </button>
  )
}

/**
 * Separates the machine's instruments from the guest's own devices. Sentence
 * case at 11px and undimmed, the same voice as the "More on this board" fold
 * beside it: two quiet labels, under which the class groups are the only
 * capitals.
 */
function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-1.5 pb-0.5 pt-2.5 text-[11px] font-medium text-muted-foreground first:pt-0.5">
      {children}
    </p>
  )
}

/**
 * The ▤ view's last line: it leaves out rows with nothing to use, and says so,
 * so that a reader who knows the board is there does not think the page lost
 * it. It is also the way to them: the devicetree view lists every node.
 */
function LeftOutLine({ count, more }: { count: number; more: boolean }) {
  return (
    <button
      type="button"
      onClick={() => setView('devicetree')}
      title="Switch to the devicetree view, which lists every node, usable or not"
      className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
    >
      <ListTree className="size-3 shrink-0" aria-hidden />
      {`${count}${more ? ' more' : ''} in the devicetree view`}
    </button>
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
        active ? 'bg-primary/15 font-semibold text-primary-text' : 'text-muted-foreground hover:text-foreground',
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
