/**
 * Call stack — the answer to "how did we get here?", which is the question a
 * breakpoint in a playground actually raises.
 *
 * Frames are clickable in the two ways that matter mid-session: peek the stack
 * slot the return address came from, or continue until that frame is back on
 * top (Run to). The thread picker reuses the same walk for threads that are
 * parked, so you can see what a blocked thread was doing when it went to sleep.
 *
 * How the frames were found is on the label, not hidden: a frame-pointer walk
 * is exact, a stack scan is a list of plausible callers.
 */

import { useEffect, useState } from 'react'
import { CornerUpLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { compactHex } from '@/debug/hexFormat'
import { describeMethod, type StackFrame, type UnwindMethod } from '@/debug/callStack'
import * as debug from '@/debug/control'

/** Sentinel for "the CPU's own context" in the thread picker. */
const CURRENT = 'current'

const ORIGIN_HINT: Record<StackFrame['origin'], string> = {
  pc: 'Stopped here (program counter)',
  lr: 'Caller from the link register — exact',
  fp: 'Followed the frame-pointer chain — exact',
  scan: 'Found by scanning the stack — plausible, not proven',
}

export function StackPane({
  snap,
  onPeek,
  seedThread,
  onSeedConsumed,
}: {
  snap: debug.DebugSnapshot
  onPeek: (addrHex: string, length?: number) => void
  /** TCB address to unwind on open (Threads → stack). */
  seedThread?: number | null
  onSeedConsumed?: () => void
}) {
  const [selected, setSelected] = useState<string>(CURRENT)
  const [threadFrames, setThreadFrames] = useState<StackFrame[]>([])
  const [threadMethod, setThreadMethod] = useState<UnwindMethod>('none')
  const [threadLoading, setThreadLoading] = useState(false)

  // Resuming invalidates any parked-thread walk — fall back to the CPU context.
  useEffect(() => {
    if (!snap.paused) setSelected(CURRENT)
  }, [snap.paused])

  useEffect(() => {
    if (seedThread == null) return
    const thread = snap.threads.find((t) => t.addr === seedThread)
    setSelected(!thread || thread.current ? CURRENT : String(seedThread))
    onSeedConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedThread])

  useEffect(() => {
    if (selected === CURRENT || !snap.paused) return
    const addr = Number(selected)
    let cancelled = false
    setThreadLoading(true)
    void debug.unwindThreadStack(addr).then((result) => {
      if (cancelled) return
      setThreadFrames(result.frames)
      setThreadMethod(result.method)
      setThreadLoading(false)
    })
    return () => {
      cancelled = true
    }
    // Re-walk on every stop: a parked thread's stack changes as it runs.
  }, [selected, snap.paused, snap.pc])

  const showingThread = selected !== CURRENT
  const frames = showingThread ? threadFrames : snap.stack
  const method = showingThread ? threadMethod : snap.stackMethod
  const loading = showingThread ? threadLoading : snap.stackLoading

  const canRunTo = snap.paused && !showingThread
  // Only worth a picker when there is something else to pick.
  const parked = snap.threads.filter((t) => !t.current && t.sp != null)
  const runTo = (frame: StackFrame) => {
    if (!canRunTo) return
    void debug.runTo(frame.addr)
  }

  return (
    <div className="space-y-1.5 px-0.5">
      {parked.length > 0 && (
        <select
          className="h-7 w-full rounded-md border border-border bg-muted/40 px-1.5 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
          value={selected}
          disabled={!snap.paused}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Call stack context"
        >
          <option value={CURRENT}>Current CPU context</option>
          {parked.map((t) => (
            <option key={t.addr} value={String(t.addr)}>
              {t.name}
            </option>
          ))}
        </select>
      )}

      {loading && frames.length === 0 ? (
        <p className="px-1 py-3 text-center text-[11px] text-foreground/60">Unwinding…</p>
      ) : frames.length === 0 ? (
        <p className="px-1 py-3 text-[11px] text-foreground/60">
          {snap.hasSymbols
            ? 'No frames recovered.'
            : 'No symbols — build unstripped for a call stack.'}
        </p>
      ) : (
        <ol className="max-h-[min(24rem,55vh)] space-y-0.5 overflow-auto">
          {frames.map((frame, i) => (
            <li
              key={`${frame.addr}-${i}-${frame.slot ?? 'reg'}`}
              className={cn(
                'flex items-baseline gap-2 rounded-md px-1.5 py-1',
                i === 0 ? 'bg-primary/10 ring-1 ring-primary/25' : 'hover:bg-muted/50',
              )}
            >
              <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-foreground/40">
                #{i}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block min-w-0 max-w-full truncate text-left text-[12px] font-medium text-foreground"
                  title={`Peek 0x${frame.addr.toString(16)} — ${ORIGIN_HINT[frame.origin]}`}
                  onClick={() => onPeek(frame.addr.toString(16))}
                >
                  {frame.label ?? `0x${frame.addr.toString(16)}`}
                </button>
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] tabular-nums text-foreground/45">
                  <span>{compactHex(frame.addr.toString(16))}</span>
                  {frame.slot != null && (
                    <button
                      type="button"
                      className="text-primary/80 underline-offset-2 hover:underline"
                      title={`Peek the stack slot at 0x${frame.slot.toString(16)}`}
                      onClick={() => onPeek(frame.slot!.toString(16))}
                    >
                      @{compactHex(frame.slot.toString(16))}
                    </button>
                  )}
                  {frame.origin === 'scan' && (
                    <span className="text-foreground/35" title={ORIGIN_HINT.scan}>
                      guess
                    </span>
                  )}
                </div>
              </div>
              {i > 0 && canRunTo && (
                <button
                  type="button"
                  // Visible rather than hover-only: on a touch screen there is
                  // no hover, and this is the pane's one action.
                  className="shrink-0 rounded p-1 text-foreground/30 transition-colors hover:bg-muted hover:text-foreground"
                  title={`Continue until ${frame.label ?? compactHex(frame.addr.toString(16))} is reached`}
                  aria-label={`Run to frame ${i}`}
                  onClick={() => runTo(frame)}
                >
                  <CornerUpLeft className="size-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {frames.length > 0 && (
        <p className="px-1 font-mono text-[10px] text-foreground/40">
          {describeMethod(method) ?? 'single frame'}
          {!showingThread && snap.stackTruncated && ' · truncated'}
        </p>
      )}
    </div>
  )
}
