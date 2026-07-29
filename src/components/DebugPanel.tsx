/**
 * The Debug dock row's body — run control + breakpoints while running;
 * CPU / Stack / Mem / Threads / Objects inspect the last stop (live when
 * paused, grayed while running). gdb only.
 *
 * Pause / Continue / Step lead the body rather than riding the row header: at
 * dock width there is no room beside the status badge, and stepping without the
 * registers and stack in view is not a thing anyone wants to do.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { CornerDownRight, CornerUpLeft, Pause, Play, Redo2 } from 'lucide-react'
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
import {
  STAGE_DEBUG_KEY,
  getState,
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

/** Run control, breakpoints and inspectors — the body of the Debug dock row. */
export function DebugBody() {
  const snap = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)

  const tab = tabIn(dock, STAGE_DEBUG_KEY, INSPECT_TABS, 'cpu') as InspectTab
  const setTab = (id: InspectTab) => setStoredTab(STAGE_DEBUG_KEY, id)
  const [peekAddr, setPeekAddr] = useState<string | null>(null)
  const [stackThread, setStackThread] = useState<number | null>(null)
  const [stepping, setStepping] = useState(false)

  useEffect(() => {
    if (focus.nonce === 0) return
    if ((INSPECT_TABS as readonly string[]).includes(focus.section)) {
      setTab(focus.section as InspectTab)
    }
    // setTab writes dock storage; nonce is the intentional trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.nonce, focus.section])

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

  return (
    <>
      {!live ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">Attaching the debugger…</p>
      ) : (
        <div className="space-y-3 p-2.5">
          {/* Run control leads the body: the thing you reach for first. */}
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={snap.paused ? 'Resume the machine' : 'Pause the machine'}
              title={snap.paused ? 'Continue' : 'Pause'}
              aria-pressed={snap.paused}
              onClick={debug.toggle}
            >
              {snap.paused ? (
                <Play className="size-4 text-primary" aria-hidden />
              ) : (
                <Pause className="size-4" aria-hidden />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!snap.paused || stepping || snap.registersLoading}
              onClick={() => void runStep(debug.step)}
              title="Step into — one instruction, calls included"
              aria-label="Step into"
            >
              <CornerDownRight className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!snap.paused || stepping || snap.registersLoading}
              onClick={() => void runStep(debug.stepOver)}
              title="Step over — run any call to completion"
              aria-label="Step over"
            >
              <Redo2 className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={!snap.paused || stepping || snap.registersLoading || !canStepOut}
              onClick={() => void runStep(debug.stepOut)}
              title={
                canStepOut
                  ? `Step out — continue to ${snap.stack[1]?.label ?? 'the caller'}`
                  : 'Step out — no caller frame recovered'
              }
              aria-label="Step out"
            >
              <CornerUpLeft className="size-4" aria-hidden />
            </Button>
          </div>

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
    </>
  )
}
