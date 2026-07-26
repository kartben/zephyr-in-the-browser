import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LayoutGrid, PanelRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as guestStats from '@/guestStats'
import * as hostTrace from '@/hostTrace'
import { useDeviceTree } from '@/hooks/useDeviceTree'
import {
  STAGE_DISPLAY_KEY,
  STAGE_PERF_KEY,
  STAGE_TRACE_KEY,
  getState,
  resetLayout,
  setHidden,
  setOpen as setDockOpen,
  subscribe,
} from '@/lib/dockStore'

export function PanelsMenu({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const state = useSyncExternalStore(subscribe, getState, getState)
  const inventory = useDeviceTree(boardId)
  const stats = useSyncExternalStore(guestStats.subscribe, guestStats.getSnapshot, guestStats.getSnapshot)

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

  const devices = inventory.nodes.filter((node) => node.presence === 'interactive')
  const hasDisplay = inventory.nodes.some((node) => node.key === 'display')
  const trace = useSyncExternalStore(hostTrace.subscribe, hostTrace.getSnapshot, hostTrace.getSnapshot)

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

      {open && (
        <div
          role="menu"
          aria-label="Panels"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-card p-2 shadow-xl"
        >
          {devices.length > 0 && (
            <>
              <MenuHeading>Dock</MenuHeading>
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

          {(hasDisplay || stats.available || trace.available || state.seed.primary.includes('trace')) && (
            <>
              <MenuHeading>Stage</MenuHeading>
              {hasDisplay && (
                <PanelToggle
                  label="Display"
                  detail="framebuffer + touch"
                  checked={state.devices[STAGE_DISPLAY_KEY]?.hidden !== true}
                  onChange={(shown) => setHidden(STAGE_DISPLAY_KEY, !shown)}
                />
              )}
              {stats.available && (
                <PanelToggle
                  label="Simulation"
                  detail="guest MIPS pill"
                  checked={state.devices[STAGE_PERF_KEY]?.hidden !== true}
                  onChange={(shown) => setHidden(STAGE_PERF_KEY, !shown)}
                />
              )}
              {(trace.available || state.seed.primary.includes('trace')) && (
                <PanelToggle
                  label="Trace"
                  detail="CTF schedule Gantt"
                  checked={state.devices[STAGE_TRACE_KEY]?.hidden !== true}
                  onChange={(shown) => setHidden(STAGE_TRACE_KEY, !shown)}
                />
              )}
            </>
          )}

          {devices.length === 0 && !hasDisplay && !stats.available && !trace.available && (
            <p className="px-1.5 py-2 text-[11px] text-muted-foreground">
              Nothing to manage yet — panels appear as the guest exposes devices.
            </p>
          )}

          <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
            <button
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => {
                resetLayout()
                setDockOpen(true)
              }}
            >
              Reset layout
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground/70">
              hidden panels persist
            </span>
          </div>
        </div>
      )}
    </span>
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

export function DockToggle() {
  const state = useSyncExternalStore(subscribe, getState, getState)
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-8 shrink-0', state.open && 'text-primary')}
      aria-label={state.open ? 'Hide the device dock' : 'Show the device dock'}
      aria-pressed={state.open}
      title={state.open ? 'Hide the device dock' : 'Show the device dock'}
      onClick={() => setDockOpen(!state.open)}
    >
      <PanelRight className="size-4" />
    </Button>
  )
}
