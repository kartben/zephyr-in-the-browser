/**
 * The dock's instruments: Simulation, Trace and Debug.
 *
 * These are attached to the *machine*, not declared by the guest's devicetree,
 * so they are not part of the device inventory — but they are panels in every
 * other respect, and used to prove it by floating over the terminal in a
 * bespoke bottom band that no other panel had. Here they are ordinary dock
 * rows: same chrome, same expand-in-place, same pop-out into a window, same
 * persisted visibility. The dockStore keys are the historical STAGE_* ones so
 * an existing user's layout carries over. The dock places their rows: under
 * an Instruments heading, or among the sample's own rows when the sample
 * names one (lib/dockSections).
 */

import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { Activity, Bug, Gauge } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DockRowShell } from '@/components/dock/DockRow'
import { PanelFrame } from '@/components/PanelFrame'
import { SimulationBadge, SimulationBody } from '@/components/SimulationPanel'
import { compactHex } from '@/debug/hexFormat'
import { countOf, traceCounts } from '@/components/dock/countText'
import { cn } from '@/lib/utils'
import type { PanelKind } from '@/boards'
import * as debug from '@/debug/control'
import * as guestStats from '@/guestStats'
import * as hostGdb from '@/hostGdb'
import * as hostTrace from '@/hostTrace'
import * as liveDebug from '@/debug/liveDebug'
import * as bridgeClient from '@/probe/client'
import { getMode, subscribe as subscribeMode } from '@/lib/modeStore'
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

function useMode() {
  return useSyncExternalStore(subscribeMode, getMode, getMode)
}

/** Stream health at a glance, for the collapsed Trace row. */
function TraceBadge() {
  const snap = useSyncExternalStore(hostTrace.subscribe, hostTrace.getSnapshot, hostTrace.getSnapshot)
  const bridge = useSyncExternalStore(
    bridgeClient.subscribe,
    bridgeClient.getSnapshot,
    bridgeClient.getSnapshot,
  )
  const mode = useMode()
  const live = snap.eventCount > 0
  const fromBoard = snap.source === 'probe' || snap.source === 'bridge' || snap.path === 'bridge'
  // A connected bridge is only a Trace story in Live board mode — a Simulator
  // session may hold the connection purely for Bridge network.
  const waitingOnBoard = mode === 'live' && bridge.phase === 'connected'
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          live ? 'bg-amber-500/80' : waitingOnBoard ? 'bg-sky-500/80' : 'bg-muted-foreground/50',
        )}
        aria-hidden
      />
      <span
        className="min-w-0 truncate"
        title={live ? `${snap.eventCount.toLocaleString('en-US')} events` : undefined}
      >
        {live
          ? `${traceCounts(snap.eventCount, snap.threadCount)}${fromBoard ? ' · board' : ''}`
          : waitingOnBoard
            ? 'waiting for board'
            : mode === 'live'
              ? 'bridge off'
              : 'no events'}
      </span>
    </span>
  )
}

/** Run state and where it stopped, for the collapsed Debug row. */
function DebugBadge() {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const gdbSnap = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)
  const liveSnap = useSyncExternalStore(
    liveDebug.subscribe,
    liveDebug.getSnapshot,
    liveDebug.getSnapshot,
  )
  const bridge = useSyncExternalStore(
    bridgeClient.subscribe,
    bridgeClient.getSnapshot,
    bridgeClient.getSnapshot,
  )
  const mode = useMode()
  const live = snap.gdb
  const bridgeSource = gdbSnap.source === 'bridge' || mode === 'live'
  const detail = !live
    ? bridgeSource
      ? liveSnap.phase === 'attaching'
        ? 'attaching'
        : liveSnap.phase === 'error'
          ? 'error'
          : bridge.phase !== 'connected'
            ? 'bridge off'
            : 'ready'
      : 'attaching'
    : snap.paused
      ? (snap.pcLabel ?? (snap.pc ? compactHex(snap.pc) : 'paused'))
      : snap.breakpoints.length > 0
        ? countOf(snap.breakpoints.length, 'breakpoint')
        : 'running'

  // Running is the top bar's green (StatusPill). Paused is the one that wants
  // the reader's attention, so it takes the warning colour: amber on a
  // running guest read as something wrong with it.
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          !live
            ? bridgeSource && liveSnap.phase === 'error'
              ? 'bg-destructive/80'
              : 'bg-muted-foreground/50'
            : snap.paused
              ? 'bg-warning'
              : 'bg-success',
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate">{detail}</span>
    </span>
  )
}

const statsAvailable = () => guestStats.getSnapshot().available
const traceAvailable = () => hostTrace.getSnapshot().available
const gdbAvailable = () => hostGdb.getSnapshot().available

interface Instrument {
  key: string
  label: string
  icon: LucideIcon
  /** Drives seeded expansion, so a sample's primaryPanels still decide. */
  panelKind: PanelKind
  /**
   * Live once its bridge is up; the row is listed either way. A boolean
   * snapshot, so the dock re-renders when it flips rather than on every tick.
   */
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
    useAvailable: () => useSyncExternalStore(guestStats.subscribe, statsAvailable, statsAvailable),
    Badge: SimulationBadge,
    Body: SimulationBody,
    window: { width: 18, height: 14 },
  },
  {
    key: STAGE_TRACE_KEY,
    label: 'Trace',
    icon: Activity,
    panelKind: 'trace',
    useAvailable: () => {
      const trace = useSyncExternalStore(hostTrace.subscribe, traceAvailable, traceAvailable)
      const mode = useMode()
      // Live board: the row is the point of the mode, and it must not blink
      // out on a reconnect. Simulator: guest trace only — a bridge kept for
      // network uplink must not summon the panel.
      return mode === 'live' || trace
    },
    Badge: TraceBadge,
    Body: TraceBody,
    window: { width: 38, height: 30 },
  },
  {
    key: STAGE_DEBUG_KEY,
    label: 'Debug',
    icon: Bug,
    panelKind: 'debug',
    useAvailable: () => useSyncExternalStore(hostGdb.subscribe, gdbAvailable, gdbAvailable),
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

export interface InstrumentRowState {
  instrument: Instrument
  shown: boolean
  windowed: boolean
  expanded: boolean
}

/**
 * Every instrument with the state its row needs, in their usual order. The
 * dock lays the rows out itself, in the same keyed list as the device rows,
 * so a view flip or a reorder moves the Trace timeline rather than remounting
 * it.
 */
export function useInstrumentRows(): InstrumentRowState[] {
  // Call once per known instrument (fixed list).
  const perf = useInstrumentState(INSTRUMENTS[0])
  const trace = useInstrumentState(INSTRUMENTS[1])
  const dbg = useInstrumentState(INSTRUMENTS[2])
  return useMemo(
    () => [
      { instrument: INSTRUMENTS[0], ...perf },
      { instrument: INSTRUMENTS[1], ...trace },
      { instrument: INSTRUMENTS[2], ...dbg },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      perf.shown, perf.windowed, perf.expanded,
      trace.shown, trace.windowed, trace.expanded,
      dbg.shown, dbg.windowed, dbg.expanded,
    ],
  )
}

export function InstrumentRow({
  instrument,
  windowed,
  expanded,
}: {
  instrument: Instrument
  windowed: boolean
  expanded: boolean
}) {
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
