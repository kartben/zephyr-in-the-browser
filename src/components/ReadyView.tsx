/**
 * Ready tab — live Zephyr ready-queue ladder.
 *
 * Timeline shows when threads ran; this shows why the scheduler picked them:
 * threads stacked by priority (lowest number on top), runner highlighted, and
 * a brief flash when a higher-priority thread steals the CPU.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  fmtTime,
  readyQueueAt,
  latestPriorityPreemption,
  priorityPreemptionsIn,
  readyStateLabel,
  STATE_COLOR,
  threadLabel,
  type Trace,
} from '@/ctf'
import * as debugUi from '@/lib/debugUi'
import * as hostGdb from '@/hostGdb'

/** How long a preemption flash stays lit after the steal lands near the edge. */
const PREEMPT_FLASH_NS = 80_000_000 // 80 ms of guest time at the window edge
const PREEMPT_FLASH_MS = 900

export function ReadyView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  toolbar,
  overlay,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  toolbar?: ReactNode
  overlay?: ReactNode
}) {
  // Sample the queue at the right edge of the shared Trace window.
  const snap = useMemo(
    () => readyQueueAt(tr, view1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, view1, eventCount],
  )
  const preemptions = useMemo(
    () => priorityPreemptionsIn(tr, view0, view1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, view0, view1, eventCount],
  )
  const latest = useMemo(
    () => latestPriorityPreemption(tr, view0, view1, view1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, view0, view1, eventCount],
  )

  const [flashTid, setFlashTid] = useState<number | null>(null)
  const [flashKey, setFlashKey] = useState(0)

  useEffect(() => {
    if (!latest) return
    // Only celebrate steals that just landed near the window's right edge
    // (live follow or scrubbed edge), not every historical one in a wide zoom.
    if (view1 - latest.ts > PREEMPT_FLASH_NS) return
    setFlashTid(latest.toTid)
    setFlashKey((k) => k + 1)
    const t = window.setTimeout(() => setFlashTid(null), PREEMPT_FLASH_MS)
    return () => window.clearTimeout(t)
  }, [latest?.ts, latest?.toTid, view1])

  const runnerName =
    snap.isr
      ? '[ISR]'
      : snap.runner != null
        ? threadLabel(tr, snap.runner)
        : snap.rungs.length === 0
          ? '(idle)'
          : '(none)'

  const onSelect = (tid: number) => {
    if (hostGdb.getSnapshot().available) {
      debugUi.focusDebugThread(tid, threadLabel(tr, tid))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {toolbar}
      <div className="relative select-none rounded border border-border/60 bg-slate-950/40">
        {overlay}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span>
            <span className="text-foreground/80">ready </span>
            {snap.rungs.length}
          </span>
          <span>
            <span className="text-foreground/80">running </span>
            <span className={cn('text-foreground', snap.isr && 'text-purple-300')}>{runnerName}</span>
          </span>
          <span>
            <span className="text-foreground/80">preempts </span>
            {preemptions.length}
          </span>
          <span className="ml-auto tabular-nums">
            {follow ? (
              <span className="text-emerald-400">LIVE</span>
            ) : (
              <span title="Ready queue at the right edge of the Trace window">
                at {fmtTime(view1)}
              </span>
            )}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 px-2.5 pt-2 text-[9px] uppercase tracking-wide text-muted-foreground/80">
          <span title="Lower numeric priority = higher scheduling priority in Zephyr">
            Higher priority
          </span>
          <span className="font-mono normal-case tracking-normal text-muted-foreground/60">
            prio ↓
          </span>
        </div>

        {snap.rungs.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            No threads in run or ready at this instant — the CPU is idle, or scrub the
            window to a busier edge.
          </p>
        ) : (
          <ol className="flex flex-col gap-1 px-2 py-2">
            {snap.rungs.map((rung, index) => {
              const isRunner = snap.runner === rung.tid && !snap.isr
              const flashing = flashTid === rung.tid
              return (
                <li key={rung.tid}>
                  <button
                    type="button"
                    onClick={() => onSelect(rung.tid)}
                    title="Open in Debug → Threads"
                    className={cn(
                      'group flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                      isRunner
                        ? 'border-emerald-500/50 bg-emerald-500/10'
                        : 'border-border/50 bg-slate-900/50 hover:border-border hover:bg-slate-900/80',
                      flashing && 'ready-preempt-flash',
                    )}
                    style={flashing ? { animationDelay: '0ms' } : undefined}
                    data-flash={flashing ? flashKey : undefined}
                  >
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded-sm font-mono text-[9px] tabular-nums text-muted-foreground"
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: STATE_COLOR[rung.state] }}
                      title={readyStateLabel(rung.state)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {rung.name || '(unnamed)'}
                    </span>
                    {rung.prio != null ? (
                      <span
                        className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
                        title="Scheduler priority (negative = cooperative)"
                      >
                        <span className="text-muted-foreground/60">prio </span>
                        {rung.prio}
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
                        prio —
                      </span>
                    )}
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide',
                        isRunner
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-amber-500/15 text-amber-200/90',
                      )}
                    >
                      {isRunner ? 'run' : 'ready'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-2.5 py-1.5 text-[9px] uppercase tracking-wide text-muted-foreground/80">
          <span>Lower priority</span>
          {latest && view1 - latest.ts <= PREEMPT_FLASH_NS ? (
            <span className="max-w-[70%] truncate font-mono normal-case tracking-normal text-amber-200/90">
              {threadLabel(tr, latest.toTid)} preempted {threadLabel(tr, latest.fromTid)}
            </span>
          ) : (
            <span className="font-mono normal-case tracking-normal text-muted-foreground/50">
              lowest number runs first
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span className="text-foreground/80">ladder:</span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: STATE_COLOR.run }} />
          run
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: STATE_COLOR.rdy }} />
          ready
        </span>
        <span className="text-border">|</span>
        <span title="A higher-priority thread (lower prio number) stole the CPU">
          flash = priority preemption
        </span>
      </div>
    </div>
  )
}
