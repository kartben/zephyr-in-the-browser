import { useEffect, useRef, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { compactHex } from '@/debug/hexFormat'
import { formatStackSize, describeThreadStatus } from '@/debug/kernel/threads'
import * as debug from '@/debug/control'
import * as debugUi from '@/lib/debugUi'
import { pulseElement } from '@/lib/dockReveal'
import { threadNameFilter, unmatchedThreadNames } from '@/tours/threadFilter'

export function ThreadsPane({
  snap,
  onPeek,
  onStack,
  only = [],
  compact = false,
}: {
  snap: debug.DebugSnapshot
  onPeek: (addrHex: string, length?: number) => void
  /** Open the Stack tab unwound for this thread (TCB address). */
  onStack?: (tcbAddr: number) => void
  /** A tour step's `threads:` names: list only these. Empty lists every thread. */
  only?: readonly string[]
  /**
   * One line per thread (name, priority, state and what it waits on), for a
   * tour card: the sentence above it is about who waits on what, and the
   * stack, cycles and addresses would push it a screen down. No scroller of
   * its own either, since the card's body already scrolls.
   */
  compact?: boolean
}) {
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (focus.nonce === 0 || focus.section !== 'threads') return
    const root = listRef.current
    if (!root) return

    const byAddr =
      focus.threadAddr != null
        ? root.querySelector<HTMLElement>(`[data-thread-addr="${focus.threadAddr}"]`)
        : null
    let el = byAddr
    if (!el && focus.threadName) {
      for (const row of root.querySelectorAll<HTMLElement>('[data-thread-name]')) {
        if (row.dataset.threadName === focus.threadName) {
          el = row
          break
        }
      }
    }
    if (!el) return

    // Wait a frame so the Threads tab / expand has painted.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => pulseElement(el!))
    })
  }, [focus.nonce, focus.section, focus.threadAddr, focus.threadName, snap.threads])

  if (!snap.threadInfo) {
    return <p className="px-1 py-3 text-[11px] text-foreground/60">No thread info</p>
  }
  if (snap.threadsLoading && snap.threads.length === 0) {
    return (
      <p className="px-1 py-3 text-center text-[11px] text-foreground/60">Reading threads…</p>
    )
  }
  if (snap.threadsError) {
    return <p className="px-1 py-3 text-[11px] text-destructive">{snap.threadsError}</p>
  }
  if (snap.threads.length === 0) {
    return <p className="px-1 py-3 text-[11px] text-foreground/60">No threads found.</p>
  }

  // Prefer priority order when the debug walk has prio (matches Trace Gantt).
  const wanted = threadNameFilter(only)
  const missing = unmatchedThreadNames(
    only,
    snap.threads.map((t) => t.name),
  )
  const threads = snap.threads.filter((t) => wanted(t.name)).sort((a, b) => {
    const aKnown = a.prio != null
    const bKnown = b.prio != null
    if (aKnown && bKnown && a.prio !== b.prio) return a.prio! - b.prio!
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    return a.addr - b.addr
  })
  const objectCoreThreads =
    snap.objects?.types.find((type) => type.code === 'THRD')?.objects ?? []
  // The rows are the last stop's while this one's walk runs: dim them, and
  // claim no running thread, rather than show the old state as the new.
  const stale = snap.threadsLoading

  return (
    <div className="space-y-1.5" aria-busy={stale || undefined}>
      {(stale || threads.some((thread) => thread.objectCore)) && (
        <div
          className={cn(
            'flex items-center justify-between px-1',
            compact
              ? 'text-[11px] text-muted-foreground'
              : 'text-[9px] uppercase tracking-wide text-foreground/40',
          )}
        >
          <span>{stale ? 'Reading the kernel…' : 'Live from the kernel'}</span>
          <span className="font-mono tabular-nums">
            {threads.length === snap.threads.length
              ? `${threads.length} threads`
              : `${threads.length} of ${snap.threads.length} threads`}
          </span>
        </div>
      )}
      <ul
        ref={listRef}
        className={cn(
          'px-0.5 transition-opacity',
          compact ? 'space-y-0.5' : 'max-h-[min(24rem,55vh)] space-y-1 overflow-auto',
          stale && 'opacity-50',
        )}
      >
        {threads.map((t) => {
          const current = t.current && !stale
          const status = describeThreadStatus(t)
          if (compact) {
            return (
              <li
                key={t.addr}
                data-thread-addr={t.addr}
                data-thread-name={t.name}
                className={cn(
                  'flex items-baseline gap-2 rounded px-2 py-1',
                  current ? 'bg-primary/10' : 'hover:bg-muted/50',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 -translate-y-0.5 self-center rounded-full',
                    current ? 'bg-primary' : 'bg-muted-foreground',
                  )}
                  aria-hidden
                />
                <button
                  type="button"
                  className="min-w-0 shrink truncate text-left text-[13px] font-medium text-foreground"
                  title={`Peek TCB at 0x${t.addr.toString(16)}`}
                  onClick={() => onPeek(t.addr.toString(16))}
                >
                  {t.name}
                </button>
                {t.prio != null && (
                  <span
                    className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
                    title="Scheduler priority (negative = cooperative)"
                  >
                    prio {t.prio}
                  </span>
                )}
                {status.label && (
                  <span className="ml-auto min-w-0 truncate text-right text-[12px] text-foreground/90">
                    {status.label}
                    {status.detail && (
                      <>
                        <span className="text-muted-foreground"> on </span>
                        {status.detailAddr != null ? (
                          <button
                            type="button"
                            className="font-mono text-primary-text underline-offset-2 hover:underline"
                            title={`Peek wait object at 0x${status.detailAddr.toString(16)}`}
                            onClick={() => onPeek(status.detailAddr!.toString(16))}
                          >
                            {status.detail}
                          </button>
                        ) : (
                          <span className="font-mono">{status.detail}</span>
                        )}
                      </>
                    )}
                  </span>
                )}
              </li>
            )
          }
          const stackAddr = t.stackStart ?? t.sp
          const runtimeStats = objectCoreThreads.find((obj) => obj.addr === t.addr)?.stats
          const totalCycles = runtimeStats?.fields.find(
            (field) => field.label === 'Total cycles',
          )
          return (
            <li
              key={t.addr}
              data-thread-addr={t.addr}
              data-thread-name={t.name}
              className={cn(
                'rounded-md px-2 py-1.5',
                current ? 'bg-primary/10 ring-1 ring-primary/25' : 'hover:bg-muted/50',
              )}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    current ? 'bg-primary' : 'bg-foreground/35',
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-[12px] font-medium text-foreground"
                      title={`Peek TCB at 0x${t.addr.toString(16)}`}
                      onClick={() => onPeek(t.addr.toString(16))}
                    >
                      {t.name}
                    </button>
                    {t.prio != null && (
                      <span
                        className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70"
                        title="Scheduler priority (negative = cooperative)"
                      >
                        <span className="text-foreground/40">prio </span>
                        {t.prio}
                      </span>
                    )}
                  </div>

                  {status.label && (
                    <div className="mt-0.5 text-[11px] leading-snug text-foreground/70">
                      <span className="text-foreground/90">{status.label}</span>
                      {status.detail && (
                        <>
                          <span className="text-foreground/40"> on </span>
                          {status.detailAddr != null ? (
                            <button
                              type="button"
                              className="font-mono text-primary-text underline-offset-2 hover:underline"
                              title={`Peek wait object at 0x${status.detailAddr.toString(16)}`}
                              onClick={() => onPeek(status.detailAddr!.toString(16))}
                            >
                              {status.detail}
                            </button>
                          ) : (
                            <span className="font-mono text-foreground/80">{status.detail}</span>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-foreground/50">
                    {t.stackSize != null && (
                      <span title="Stack buffer size">
                        stack {formatStackSize(t.stackSize)}
                      </span>
                    )}
                    {totalCycles && (
                      <span title="Object-core runtime statistics">
                        cycles {totalCycles.value}
                      </span>
                    )}
                    {stackAddr != null && (
                      <button
                        type="button"
                        className="text-primary-text/90 underline-offset-2 hover:underline"
                        title={
                          t.stackStart != null
                            ? `Peek stack at 0x${t.stackStart.toString(16)}`
                            : `Peek SP 0x${stackAddr.toString(16)}`
                        }
                        onClick={() => onPeek(stackAddr.toString(16), 128)}
                      >
                        Mem {compactHex(stackAddr.toString(16))}
                      </button>
                    )}
                    <button
                      type="button"
                      className="hover:text-foreground/70"
                      title="Peek thread control block"
                      onClick={() => onPeek(t.addr.toString(16))}
                    >
                      tcb {compactHex(t.addr.toString(16))}
                    </button>
                    {onStack && (t.current || t.sp != null) && (
                      <button
                        type="button"
                        className="text-primary-text/90 underline-offset-2 hover:underline"
                        title={
                          t.current
                            ? 'Call stack for the running context'
                            : `Unwind ${t.name}'s stack`
                        }
                        onClick={() => onStack(t.addr)}
                      >
                        stack
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      {missing.length > 0 && (
        <p className={cn('px-1', compact ? 'text-[11px] text-muted-foreground' : 'text-[10.5px] text-foreground/50')}>
          No thread here is named {missing.map((name) => `“${name}”`).join(', ')}.
        </p>
      )}
    </div>
  )
}
