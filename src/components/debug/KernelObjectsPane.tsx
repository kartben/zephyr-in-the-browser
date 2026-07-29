import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Search } from 'lucide-react'
import { compactHex } from '@/debug/hexFormat'
import { describeThreadStatus, formatStackSize } from '@/debug/kernel/threads'
import { cn } from '@/lib/utils'
import * as debugUi from '@/lib/debugUi'
import { pulseElement } from '@/lib/dockReveal'
import type * as debug from '@/debug/control'

export function KernelObjectsPane({
  snap,
  onPeek,
  onThread,
}: {
  snap: debug.DebugSnapshot
  onPeek: (addrHex: string, length?: number) => void
  onThread?: (tcbAddr: number) => void
}) {
  const [query, setQuery] = useState('')
  const focus = useSyncExternalStore(debugUi.subscribe, debugUi.getSnapshot, debugUi.getSnapshot)
  const listRef = useRef<HTMLDivElement>(null)
  const objects = snap.objects
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    if (!objects) return []
    return objects.types
      .map((type) => ({
        ...type,
        objects: type.objects.filter((obj) => {
          if (!q) return true
          return (
            type.name.toLowerCase().includes(q) ||
            type.code.toLowerCase().includes(q) ||
            obj.name.toLowerCase().includes(q) ||
            obj.addr.toString(16).includes(q)
          )
        }),
      }))
      .filter((type) => type.objects.length > 0)
  }, [objects, q])

  /*
   * Somebody elsewhere pointed at one object — a fork on a tour card, say.
   * Open the group it lives in (a collapsed <details> keeps its rows in the DOM
   * but out of view, so scrolling to one would land nowhere) and blink it.
   */
  useEffect(() => {
    if (focus.nonce === 0 || focus.section !== 'objects' || focus.objectAddr == null) return
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-object-addr="${focus.objectAddr}"]`,
    )
    if (!row) return
    row.closest('details')?.setAttribute('open', '')
    // Wait a frame so opening the group has painted.
    requestAnimationFrame(() => pulseElement(row))
  }, [focus.nonce, focus.section, focus.objectAddr, objects])

  if (!snap.objectCores) {
    return (
      <div className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[11px] leading-relaxed text-foreground/60">
        No kernel object list in this App. Use a build with object-core support
        (and symbols) to inspect queues, mutexes, and threads here.
      </div>
    )
  }
  if (snap.objectsLoading && !objects) {
    return <p className="px-1 py-3 text-center text-[11px] text-foreground/60">Reading object cores…</p>
  }
  if (snap.objectsError) {
    return <p className="px-1 py-3 text-[11px] text-destructive">{snap.objectsError}</p>
  }
  if (!objects || objects.objectCount === 0) {
    return <p className="px-1 py-3 text-[11px] text-foreground/60">No linked kernel objects.</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <label className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-foreground/35"
            aria-hidden
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter objects"
            aria-label="Filter kernel objects"
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 font-mono text-[10px] outline-none placeholder:text-foreground/35 focus:border-primary/50"
          />
        </label>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/50">
          {objects.objectCount} obj
          {objects.statsCount > 0 ? ` · ${objects.statsCount} stats` : ''}
          {objects.truncated ? ' · capped' : ''}
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="px-1 py-3 text-center text-[11px] text-foreground/50">No matching objects.</p>
      ) : (
        <div ref={listRef} className="max-h-[min(30rem,62vh)] space-y-1.5 overflow-auto pr-0.5">
          {groups.map((type) => (
            <details
              key={type.addr}
              open={!q || groups.length <= 4}
              className="group rounded-md border border-border/70 bg-background/45"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-muted/35">
                <span className="font-mono text-[9px] font-semibold tracking-wide text-primary/80">
                  {type.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                  {type.name}
                </span>
                {type.objectSize != null && (
                  <span className="font-mono text-[9px] text-foreground/35">
                    {formatStackSize(type.objectSize)}
                  </span>
                )}
                <span className="rounded-full bg-muted px-1.5 font-mono text-[9px] tabular-nums text-foreground/65">
                  {type.objects.length}
                </span>
              </summary>

              <ul className="border-t border-border/55">
                {type.objects.map((obj) => {
                  const thread =
                    type.code === 'THRD'
                      ? snap.threads.find((candidate) => candidate.addr === obj.addr)
                      : undefined
                  const status = thread ? describeThreadStatus(thread) : null
                  const title = thread?.name || obj.name
                  return (
                    <li
                      key={obj.coreAddr}
                      data-object-addr={obj.addr}
                      className={cn(
                        'border-b border-border/45 px-2 py-2 last:border-b-0',
                        thread?.current && 'bg-primary/[0.06]',
                      )}
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-[11px] font-medium hover:text-primary"
                          title={`Peek ${obj.typeName.toLowerCase()} at 0x${obj.addr.toString(16)}`}
                          onClick={() => onPeek(obj.addr.toString(16), obj.size ?? undefined)}
                        >
                          {title}
                        </button>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 py-0.5 text-[8px] uppercase tracking-wide',
                            obj.staticObject
                              ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                              : 'bg-muted text-foreground/45',
                          )}
                        >
                          {obj.staticObject ? 'static' : 'live'}
                        </span>
                      </div>
                      {thread && obj.name !== thread.name && (
                        <div className="truncate font-mono text-[9px] text-foreground/40">
                          {obj.name}
                        </div>
                      )}

                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9px] tabular-nums text-foreground/45">
                        <button
                          type="button"
                          className="hover:text-primary"
                          onClick={() => onPeek(obj.addr.toString(16), obj.size ?? undefined)}
                        >
                          obj {compactHex(obj.addr.toString(16))}
                        </button>
                        <button
                          type="button"
                          className="hover:text-primary"
                          onClick={() => onPeek(obj.coreAddr.toString(16))}
                        >
                          core +0x{(obj.coreAddr - obj.addr).toString(16)}
                        </button>
                        {obj.size != null && <span>{formatStackSize(obj.size)}</span>}
                        {thread && onThread && (
                          <button
                            type="button"
                            className="text-primary/90 hover:underline"
                            onClick={() => onThread(thread.addr)}
                          >
                            Threads
                          </button>
                        )}
                      </div>

                      {(status?.label || obj.fields.length > 0) && (
                        <dl className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[10px]">
                          {status?.label && (
                            <>
                              <dt className="text-foreground/45">State</dt>
                              <dd className="text-right text-foreground/75">
                                {status.label}
                                {status.detail ? ` · ${status.detail}` : ''}
                              </dd>
                            </>
                          )}
                          {thread?.prio != null && (
                            <>
                              <dt className="text-foreground/45">Priority</dt>
                              <dd className="font-mono text-right tabular-nums">{thread.prio}</dd>
                            </>
                          )}
                          {obj.fields.map((field) => (
                            <div key={field.label} className="contents">
                              <dt className="truncate text-foreground/45">{field.label}</dt>
                              <dd className="max-w-48 truncate font-mono text-right tabular-nums text-foreground/75">
                                {field.addr ? (
                                  <button
                                    type="button"
                                    className="hover:text-primary hover:underline"
                                    onClick={() => onPeek(field.addr!.toString(16))}
                                  >
                                    {field.value}
                                  </button>
                                ) : (
                                  field.value
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {obj.stats && (
                        <details className="mt-1.5 rounded bg-muted/45 px-1.5 py-1">
                          <summary className="cursor-pointer list-none text-[9px] font-semibold uppercase tracking-wide text-foreground/55">
                            Statistics · {obj.stats.rawSize} B raw
                          </summary>
                          {obj.stats.fields.length > 0 ? (
                            <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[9px]">
                              {obj.stats.fields.map((field) => (
                                <div key={field.label} className="contents">
                                  <dt className="text-foreground/45">{field.label}</dt>
                                  <dd className="font-mono text-right tabular-nums">{field.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : (
                            <code className="mt-1 block break-all text-[8px] leading-relaxed text-foreground/55">
                              {obj.stats.rawHex}
                            </code>
                          )}
                        </details>
                      )}
                    </li>
                  )
                })}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
