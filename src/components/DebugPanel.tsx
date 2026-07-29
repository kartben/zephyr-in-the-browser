/**
 * Stage Debug panel — run control + breakpoints while running;
 * CPU / Mem / Threads inspect the last stop (live when paused, grayed while
 * running). gdb only (Panels menu).
 *
 * Pause / Continue / Step live in the panel header (not the TopBar) so a
 * debug session stays in one place.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bug, CornerDownRight, CornerUpLeft, Pause, Play, Redo2 } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { Button } from '@/components/ui/button'
import { RegisterGrid } from '@/components/RegisterGrid'
import { BreakpointsPane } from '@/components/debug/BreakpointsPane'
import { MemoryPane } from '@/components/debug/MemoryPane'
import { StackPane } from '@/components/debug/StackPane'
import { ThreadsPane } from '@/components/debug/ThreadsPane'
import { KernelObjectsPane } from '@/components/debug/KernelObjectsPane'
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
  setTab as setStoredTab,
  subscribe as subscribeDock,
  tabIn,
} from '@/lib/dockStore'

type InspectTab = 'cpu' | 'stack' | 'memory' | 'threads' | 'objects'

const INSPECT_TABS = [
  'cpu',
  'stack',
  'memory',
  'threads',
  'objects',
] as const satisfies readonly InspectTab[]

export function DebugPanel({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const gdb = useSyncExternalStore(hostGdb.subscribe, hostGdb.getSnapshot, hostGdb.getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)

  const tab = tabIn(dock, STAGE_DEBUG_KEY, INSPECT_TABS, 'cpu') as InspectTab
  const setTab = (id: InspectTab) => setStoredTab(STAGE_DEBUG_KEY, id)
  const [peekAddr, setPeekAddr] = useState<string | null>(null)
  const [stackThread, setStackThread] = useState<number | null>(null)
  const [stepping, setStepping] = useState(false)

  useEffect(() => {
    if (defaultExpanded || snap.gdb) setExpanded(STAGE_DEBUG_KEY, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded, snap.gdb])

  useEffect(() => {
    if (focus.nonce === 0) return
    if ((INSPECT_TABS as readonly string[]).includes(focus.section)) {
      setTab(focus.section as InspectTab)
    }
    // setTab writes dock storage; nonce is the intentional trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce, focus.section])

  if (!gdb.available || dock.devices[STAGE_DEBUG_KEY]?.hidden) return null

  const expanded = defaultExpanded || snap.gdb || effectiveExpandedIn(dock, STAGE_DEBUG_KEY, 'debug')
  const live = snap.gdb

  const onPeek = (addrHex: string, _length?: number) => {
    if (!snap.paused) return
    setPeekAddr(compactHex(addrHex))
    setTab('memory')
  }

  /** One run-control action at a time — RSP answers a single packet at a time. */
  const runStep = async (action: () => Promise<unknown>) => {
    if (stepping || !snap.canStep || !snap.paused) return
    setStepping(true)
    try {
      await action()
    } finally {
      setStepping(false)
    }
  }

  /** Frame #0 is the PC itself, so a caller frame is what Step out needs. */
  const canStepOut = snap.stack.length > 1

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
      dismissible={false}
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
      actions={
        live ? (
          <span className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={snap.paused ? 'Resume the machine' : 'Pause the machine'}
              title={snap.paused ? 'Continue' : 'Pause'}
              aria-pressed={snap.paused}
              onClick={debug.toggle}
            >
              {snap.paused ? (
                <Play className="size-3.5 text-primary" aria-hidden />
              ) : (
                <Pause className="size-3.5" aria-hidden />
              )}
            </Button>
            {snap.paused && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={stepping || snap.registersLoading}
                  onClick={() => void runStep(debug.step)}
                  title="Step into — one instruction, calls included"
                  aria-label="Step into"
                >
                  <CornerDownRight className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={stepping || snap.registersLoading}
                  onClick={() => void runStep(debug.stepOver)}
                  title="Step over — run any call to completion"
                  aria-label="Step over"
                >
                  <Redo2 className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={stepping || snap.registersLoading || !canStepOut}
                  onClick={() => void runStep(debug.stepOut)}
                  title={
                    canStepOut
                      ? `Step out — continue to ${snap.stack[1]?.label ?? 'the caller'}`
                      : 'Step out — no caller frame recovered'
                  }
                  aria-label="Step out"
                >
                  <CornerUpLeft className="size-3.5" aria-hidden />
                </Button>
              </>
            )}
          </span>
        ) : undefined
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

          <section>
            <div className="mb-1.5 flex gap-0.5 px-1">
              {(
                [
                  ['cpu', 'CPU'],
                  ['stack', 'Stack'],
                  ['memory', 'Mem'],
                  ['threads', 'Threads'],
                  ['objects', 'Objects'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  title={id === 'objects' ? 'Kernel objects' : undefined}
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

            <div
              className={cn(
                'transition-opacity',
                !snap.paused && 'pointer-events-none select-none opacity-45',
              )}
              aria-disabled={!snap.paused}
            >
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
              {tab === 'stack' && (
                <StackPane
                  snap={snap}
                  onPeek={onPeek}
                  seedThread={stackThread}
                  onSeedConsumed={() => setStackThread(null)}
                />
              )}
              {tab === 'memory' && (
                <MemoryPane
                  snap={snap}
                  seedAddr={peekAddr}
                  onSeedConsumed={() => setPeekAddr(null)}
                />
              )}
              {tab === 'threads' && (
                <ThreadsPane
                  snap={snap}
                  onPeek={onPeek}
                  onStack={(addr) => {
                    if (!snap.paused) return
                    setStackThread(addr)
                    setTab('stack')
                  }}
                />
              )}
              {tab === 'objects' && (
                <KernelObjectsPane
                  snap={snap}
                  onPeek={onPeek}
                  onThread={(addr) => debugUi.focusDebugThread(addr)}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </PanelFrame>
  )
}
