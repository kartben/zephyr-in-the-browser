/**
 * The way back. Hiding a panel used to be a one-way door (the old layout
 * persisted nothing about visibility because nothing could undo it); this
 * menu lists every device row and instrument with a checkbox, so hidden is
 * a state, not a goodbye — which is exactly what lets dockStore persist it.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LayoutGrid, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as guestStats from '@/guestStats'
import * as hostGdb from '@/hostGdb'
import * as hostTrace from '@/hostTrace'
import { useDeviceTree } from '@/hooks/useDeviceTree'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import {
  STAGE_DEBUG_KEY,
  STAGE_PERF_KEY,
  STAGE_TRACE_KEY,
  getState,
  resetLayout,
  setDrawerOpen,
  setHidden,
  setOpen as setDockOpen,
  showDock,
  subscribe,
} from '@/lib/dockStore'

export function PanelsMenu({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  // Light-dismiss: outside pointerdown or Escape closes the popover.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <span ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={cn('size-8 shrink-0', open && 'bg-secondary')}
        aria-label="Panels menu"
        aria-expanded={open}
        title="Show or hide panels"
        onClick={() => setOpen((o) => !o)}
      >
        <LayoutGrid className="size-4" />
      </Button>

      {/* Inventory / stats / trace subscriptions only while open — the closed
          button does not need them, and guestStats/hostTrace tick at 2–5 Hz. */}
      {open && <PanelsMenuPopover boardId={boardId} />}
    </span>
  )
}

function PanelsMenuPopover({ boardId }: { boardId: string }) {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const inventory = useDeviceTree(boardId)
  const stats = useSyncExternalStore(guestStats.subscribe, guestStats.getSnapshot, guestStats.getSnapshot)
  const trace = useSyncExternalStore(hostTrace.subscribe, hostTrace.getSnapshot, hostTrace.getSnapshot)
  const gdb = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)

  const devices = inventory.nodes.filter((node) => node.presence === 'interactive')
  const instruments = [
    { key: STAGE_PERF_KEY, label: 'Simulation', shown: stats.available },
    {
      key: STAGE_TRACE_KEY,
      label: 'Trace',
      shown: trace.available || state.seed.primary.includes('trace'),
    },
    {
      key: STAGE_DEBUG_KEY,
      label: 'Debug',
      shown: gdb.available || state.seed.primary.includes('debug'),
    },
  ].filter((row) => row.shown)

  return (
    <div
      role="menu"
      aria-label="Panels"
      className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-card p-2 shadow-xl"
    >
      {instruments.length > 0 && (
        <>
          <MenuHeading>Instruments</MenuHeading>
          {instruments.map((row) => (
            <PanelToggle
              key={row.key}
              label={row.label}
              checked={state.devices[row.key]?.hidden !== true}
              onChange={(shown) => setHidden(row.key, !shown)}
            />
          ))}
        </>
      )}

      {devices.length > 0 && (
        <>
          <MenuHeading>Devices</MenuHeading>
          <div className="max-h-64 overflow-y-auto">
            {devices.map((node) => (
              <PanelToggle
                key={node.key}
                label={node.label}
                detail={node.crumb ?? node.compatible}
                checked={state.devices[node.key]?.hidden !== true}
                onChange={(shown) => setHidden(node.key, !shown)}
              />
            ))}
          </div>
        </>
      )}

      {devices.length === 0 && instruments.length === 0 && (
        <p className="px-1.5 py-2 text-[11px] text-muted-foreground">
          Nothing ready to show yet.
        </p>
      )}

      <div className="mt-2 border-t border-border pt-2">
        <button
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            resetLayout()
            showDock()
          }}
        >
          Reset layout
        </button>
      </div>
    </div>
  )
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-0.5">
      {children}
    </p>
  )
}

function PanelToggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-secondary/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[var(--color-primary)]"
      />
      <span className={cn('truncate', !checked && 'text-muted-foreground')}>{label}</span>
      {detail && (
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground/80">
          {detail}
        </span>
      )}
    </label>
  )
}

/** TopBar toggle for the dock itself — the way back from a collapsed dock. */
export function DockToggle() {
  const state = useSyncExternalStore(subscribe, getState, getState)
  const desktop = useIsDesktop()
  // Desktop toggles the persistent sidebar; narrow toggles the session drawer.
  const shown = desktop ? state.open : state.drawerOpen
  const label = shown ? 'Hide the device dock' : 'Show the device dock'
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-8 shrink-0', shown && 'text-primary')}
      aria-label={label}
      aria-pressed={shown}
      title={label}
      onClick={() => (desktop ? setDockOpen(!shown) : setDrawerOpen(!shown))}
    >
      <PanelRight className="size-4" />
    </Button>
  )
}
