/**
 * The dock's Instruments section: Simulation, Trace and Debug.
 *
 * These are attached to the *machine*, not declared by the guest's devicetree,
 * so they are not part of the device inventory — but they are panels in every
 * other respect, and used to prove it by floating over the terminal in a
 * bespoke bottom band that no other panel had. Here they are ordinary dock
 * rows: same chrome, same expand-in-place, same pop-out into a window, same
 * persisted visibility. The dockStore keys are the historical STAGE_* ones so
 * an existing user's layout carries over.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { Activity, Bug, Gauge } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DockRowShell } from '@/components/dock/DockRow'
import { PanelFrame } from '@/components/PanelFrame'
import { SimulationBadge, SimulationBody } from '@/components/SimulationPanel'
import { compactHex } from '@/debug/hexFormat'
import { cn } from '@/lib/utils'
import type { PanelKind } from '@/boards'
import * as debug from '@/debug/control'
import * as guestStats from '@/guestStats'
import * as hostGdb from '@/hostGdb'
import * as hostTrace from '@/hostTrace'
import {
  STAGE_DEBUG_KEY,
  STAGE_PERF_KEY,
  STAGE_TRACE_KEY,
  effectiveExpandedIn,
  getState,
  setExpanded,
  setWindowed,
  subscribe,
} from '@/lib/dockStore'

/*
 * Trace and Debug carry the two heaviest subtrees in the app — the CTF timeline
 * with its d3 charts, and the whole gdb inspector — and splitting them out with
 * React.lazy is tempting (~50 kB gzipped off the entry chunk). It is not worth
 * it: the suspended boundary kept showing its fallback until some unrelated
 * state change forced a re-render, so a tracing sample opened on "Loading…" and
 * stayed there. A panel that looks broken costs more than the bytes save.
 */
import { DebugBody } from '@/components/DebugPanel'
import { TraceBody } from '@/components/TracePanel'

/** Stream health at a glance, for the collapsed Trace row. */
function TraceBadge() {
  const snap = useSyncExternalStore(hostTrace.subscribe, hostTrace.getSnapshot, hostTrace.getSnapshot)
  const live = snap.eventCount > 0
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-amber-500/80' : 'bg-muted-foreground/50',
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate">
        {live ? `${snap.eventCount} evt · ${snap.threadCount} thr` : 'no events'}
      </span>
    </span>
  )
}

/** Run state and where it stopped, for the collapsed Debug row. */
function DebugBadge() {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const live = snap.gdb
  const detail = !live
    ? 'attaching'
    : snap.paused
      ? (snap.pcLabel ?? (snap.pc ? compactHex(snap.pc) : 'paused'))
      : snap.breakpoints.length > 0
        ? `${snap.breakpoints.length} bp${snap.breakpoints.length === 1 ? '' : 's'}`
        : 'running'

  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          !live ? 'bg-muted-foreground/50' : snap.paused ? 'bg-emerald-500/90' : 'bg-amber-500/80',
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate">{detail}</span>
    </span>
  )
}

interface Instrument {
  key: string
  label: string
  icon: LucideIcon
  /** Drives seeded expansion, so a sample's primaryPanels still decide. */
  panelKind: PanelKind
  /** Live once its bridge is up; the row is listed either way. */
  useAvailable: () => boolean
  Badge: () => ReactNode
  Body: () => ReactNode
  /** First pop-out size, in rem. */
  window: { width: number; height: number }
}

export const INSTRUMENTS: Instrument[] = [
  {
    key: STAGE_PERF_KEY,
    label: 'Simulation',
    icon: Gauge,
    panelKind: 'perf',
    useAvailable: () =>
      useSyncExternalStore(guestStats.subscribe, guestStats.getSnapshot, guestStats.getSnapshot)
        .available,
    Badge: SimulationBadge,
    Body: SimulationBody,
    window: { width: 18, height: 14 },
  },
  {
    key: STAGE_TRACE_KEY,
    label: 'Trace',
    icon: Activity,
    panelKind: 'trace',
    useAvailable: () =>
      useSyncExternalStore(hostTrace.subscribe, hostTrace.getSnapshot, hostTrace.getSnapshot)
        .available,
    Badge: TraceBadge,
    Body: TraceBody,
    window: { width: 38, height: 30 },
  },
  {
    key: STAGE_DEBUG_KEY,
    label: 'Debug',
    icon: Bug,
    panelKind: 'debug',
    useAvailable: () =>
      useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot).available,
    Badge: DebugBadge,
    Body: DebugBody,
    window: { width: 26, height: 30 },
  },
]

/**
 * Whether an instrument has anything to say yet. Its bridge being live is the
 * honest answer, but a sample whose seed names it (a tracing or debug demo)
 * gets its row from the first paint so the list does not shuffle on attach —
 * the same rule device rows follow.
 */
function useInstrumentState(instrument: Instrument) {
  const available = instrument.useAvailable()
  const state = useSyncExternalStore(subscribe, getState, getState)
  const shown =
    state.devices[instrument.key]?.hidden !== true &&
    (available || state.seed.primary.includes(instrument.panelKind))
  return {
    shown,
    windowed: state.devices[instrument.key]?.windowed === true,
    expanded: effectiveExpandedIn(state, instrument.key, instrument.panelKind),
  }
}

export function DockInstruments() {
  return (
    <>
      {INSTRUMENTS.map((instrument) => (
        <InstrumentRow key={instrument.key} instrument={instrument} />
      ))}
    </>
  )
}

function InstrumentRow({ instrument }: { instrument: Instrument }) {
  const { shown, windowed, expanded } = useInstrumentState(instrument)
  if (!shown) return null
  const { Badge, Body } = instrument

  return (
    <DockRowShell
      dockKey={instrument.key}
      icon={instrument.icon}
      name={instrument.label}
      nameClassName="font-medium"
      badge={<Badge />}
      expanded={expanded}
      onToggle={() => setExpanded(instrument.key, !expanded)}
      windowed={windowed}
      onWindowedChange={(next) => setWindowed(instrument.key, next)}
      windowLabel={instrument.label}
    >
      <Body />
    </DockRowShell>
  )
}

/** The popped-out instruments, alongside FloatingWindows' popped-out devices. */
export function InstrumentWindows() {
  return (
    <>
      {INSTRUMENTS.map((instrument) => (
        <InstrumentWindow key={instrument.key} instrument={instrument} />
      ))}
    </>
  )
}

function InstrumentWindow({ instrument }: { instrument: Instrument }) {
  const { shown, windowed } = useInstrumentState(instrument)
  if (!shown || !windowed) return null
  const { Badge, Body } = instrument

  return (
    <PanelFrame
      id={instrument.key}
      title={instrument.label}
      icon={instrument.icon}
      dockedWidth={instrument.window.width}
      seedHeight={instrument.window.height}
      side="left"
      windowed={{ onClose: () => setWindowed(instrument.key, false) }}
      status={<Badge />}
    >
      <Body />
    </PanelFrame>
  )
}
