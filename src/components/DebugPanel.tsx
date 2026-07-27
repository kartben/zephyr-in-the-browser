/**
 * Stage Debug panel — breakpoints while running; CPU / Mem / Threads when paused.
 * Opened from the Panels menu (gdb only). TopBar Pause / Step / PC chip stay thin.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bug } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { RegisterGrid } from '@/components/RegisterGrid'
import { BreakpointsPane } from '@/components/debug/BreakpointsPane'
import { MemoryPane } from '@/components/debug/MemoryPane'
import { ThreadsPane } from '@/components/debug/ThreadsPane'
import { compactHex } from '@/debug/hexFormat'
import { cn } from '@/lib/utils'
import * as debug from '@/debug/control'
import * as debugUi from '@/lib/debugUi'
import * as hostGdb from '@/hostGdb'
import {
  STAGE_DEBUG_KEY,
  effectiveExpandedIn,
  getState,
  setExpanded,
  subscribe as subscribeDock,
} from '@/lib/dockStore'

type InspectTab = 'cpu' | 'memory' | 'threads'

export function DebugPanel({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const gdb = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)

  const [tab, setTab] = useState<InspectTab>('cpu')
  const [peekAddr, setPeekAddr] = useState<string | null>(null)
  const [peekLen, setPeekLen] = useState(64)

  useEffect(() => {
    if (defaultExpanded) setExpanded(STAGE_DEBUG_KEY, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded])

  useEffect(() => {
    if (focus.nonce === 0) return
    if (focus.section === 'cpu' || focus.section === 'memory' || focus.section === 'threads') {
      setTab(focus.section)
    }
  }, [focus.nonce, focus.section])

  // Drop inspect tab selection when we resume (tabs vanish).
  useEffect(() => {
    if (!snap.paused && (tab === 'memory' || tab === 'threads')) setTab('cpu')
  }, [snap.paused, tab])

  if (!gdb.available || dock.devices[STAGE_DEBUG_KEY]?.hidden) return null

  const expanded = defaultExpanded || effectiveExpandedIn(dock, STAGE_DEBUG_KEY, 'debug')
  const live = snap.gdb

  const onPeek = (addrHex: string, length = 64) => {
    setPeekAddr(compactHex(addrHex))
    setPeekLen(length)
    setTab('memory')
  }

  const statusLabel = !live ? 'gdb' : snap.paused ? 'paused' : 'running'
  const statusDetail = !live
    ? 'waiting…'
    : snap.paused
      ? snap.pcLabel
        ? snap.pcLabel
        : snap.pc
          ? compactHex(snap.pc)
          : null
      : snap.breakpoints.length > 0
        ? `${snap.breakpoints.length} bp${snap.breakpoints.length === 1 ? '' : 's'}`
        : null

  return (
    <PanelFrame
      id={STAGE_DEBUG_KEY}
      title="Debug"
      icon={Bug}
      defaultExpanded={expanded}
      dockedWidth={24}
      seedHeight={28}
      side="left"
      status={
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              !live
                ? 'bg-muted-foreground/50'
                : snap.paused
                  ? 'bg-emerald-500/90'
                  : 'bg-amber-500/80',
            )}
            aria-hidden
          />
          <span className="shrink-0 text-foreground/70">{statusLabel}</span>
          {statusDetail && (
            <span className="min-w-0 truncate text-muted-foreground">{statusDetail}</span>
          )}
        </span>
      }
    >
      {!live ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">Waiting for gdb session…</p>
      ) : (
        <div className="space-y-3 p-2.5">
          <section>
            <h3 className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Breakpoints
            </h3>
            <BreakpointsPane snap={snap} />
          </section>

          {snap.paused && (
            <section>
              <div className="mb-1.5 flex gap-0.5 px-1">
                {(
                  [
                    ['cpu', 'CPU'],
                    ['memory', 'Mem'],
                    ['threads', 'Threads'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={cn(
                      'rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide',
                      tab === id
                        ? 'bg-secondary text-foreground'
                        : 'text-foreground/55 hover:bg-muted/60 hover:text-foreground',
                    )}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'cpu' && (
                <RegisterGrid
                  dump={snap.registers}
                  loading={snap.registersLoading}
                  onPeek={onPeek}
                  pcLabel={snap.pcLabel}
                  formals={snap.regFormals}
                  arch={snap.regArch}
                />
              )}
              {tab === 'memory' && (
                <MemoryPane
                  snap={snap}
                  seedAddr={peekAddr}
                  seedLen={peekLen}
                  onSeedConsumed={() => setPeekAddr(null)}
                />
              )}
              {tab === 'threads' && <ThreadsPane snap={snap} onPeek={onPeek} />}
            </section>
          )}
        </div>
      )}
    </PanelFrame>
  )
}
