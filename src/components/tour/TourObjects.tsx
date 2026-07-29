/**
 * The `objects:` card — the kernel objects a step is about, live.
 *
 * `CONFIG_OBJ_CORE` links every mutex, semaphore, message queue and thread onto
 * a per-type list, so the debugger can enumerate them without being told any
 * addresses, and read each one's state through the DWARF the build already
 * carries. A step that says "six forks, and this philosopher wants that one"
 * gets to put all six on screen with the owner of each next to it — no watch
 * expressions, no hand-computed struct offsets, and nothing in the guest that
 * knows a tour is running.
 *
 * Rendered from the live snapshot rather than from bytes copied into the card,
 * the same as `threads:`: the object walk lands a beat after the registers, so
 * anything sampled while the card was being built would be a stop behind.
 */

import { Boxes } from 'lucide-react'
import * as debugUi from '@/lib/debugUi'
import type * as debug from '@/debug/control'
import type { TourObjects as TourObjectsSpec } from '@/tours/store'
import { cn } from '@/lib/utils'

/** Objects shown before the list is cut off — a card is not the Objects pane. */
const MAX_ROWS = 8

/**
 * A mutex owner and a msgq's waiter are thread pointers, and the thread walk has
 * already put a name to every TCB in the guest. "Philosopher 4" is the answer to
 * "who is holding this fork"; `0x40018e80` is the same answer in a form the
 * reader has to go and look up.
 */
function nameThread(snap: debug.DebugSnapshot, addr: number | undefined): string | null {
  if (addr === undefined) return null
  return snap.threads.find((thread) => thread.addr === addr)?.name || null
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-dashed border-border/70 px-2 py-1.5 text-[10.5px] text-muted-foreground">
      {children}
    </p>
  )
}

export function TourObjects({
  spec,
  snap,
  live,
}: {
  spec: TourObjectsSpec
  snap: debug.DebugSnapshot
  live: boolean
}) {
  if (!live) {
    return <Note>Kernel objects are read from the running machine — boot the emulator to see them.</Note>
  }
  if (!snap.objectCores) {
    return <Note>This build has no object-core metadata (CONFIG_OBJ_CORE).</Note>
  }
  if (!snap.objects) {
    return <Note>{snap.objectsError ?? 'Reading object cores…'}</Note>
  }

  const groups = snap.objects.types.filter(
    (type) => type.objects.length > 0 && (spec.types.length === 0 || spec.types.includes(type.code)),
  )
  if (groups.length === 0) {
    return <Note>This guest has no such objects linked yet.</Note>
  }

  return (
    <div className="overflow-hidden rounded border border-border bg-muted/30">
      {groups.map((type) => {
        const shown = type.objects.slice(0, MAX_ROWS)
        return (
          <div key={type.addr} className="border-b border-border/60 last:border-b-0">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <Boxes className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="text-[10.5px] text-muted-foreground">{type.name}</span>
              <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
                {type.objects.length}
              </span>
            </div>
            <ul>
              {shown.map((obj) => {
                const focused = spec.focus !== null && spec.focus === obj.addr
                return (
                  <li
                    key={obj.coreAddr}
                    className={cn(
                      'flex items-baseline gap-2 border-t border-border/40 px-2 py-1',
                      focused && 'bg-primary/15',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => debugUi.focusDebug('objects')}
                      title={`0x${obj.addr.toString(16)} — open the Objects pane`}
                      className={cn(
                        'min-w-0 shrink-0 basis-1/3 truncate text-left font-mono text-[11px] hover:text-primary',
                        focused ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {obj.name}
                    </button>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-end gap-x-2.5 gap-y-0.5">
                      {obj.fields.length === 0 ? (
                        <span className="font-mono text-[10.5px] text-muted-foreground/60">
                          0x{obj.addr.toString(16)}
                        </span>
                      ) : (
                        obj.fields.map((field) => {
                          const thread = nameThread(snap, field.addr)
                          return (
                            <span key={field.label} className="flex items-baseline gap-1">
                              <span className="text-[10px] text-muted-foreground/70">
                                {field.label}
                              </span>
                              <span
                                className="font-mono text-[11px] tabular-nums text-foreground"
                                title={thread ? field.value : undefined}
                              >
                                {thread ?? field.value}
                              </span>
                            </span>
                          )
                        })
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {type.objects.length > shown.length && (
              <p className="border-t border-border/40 px-2 py-1 text-[10px] text-muted-foreground/70">
                and {type.objects.length - shown.length} more, in Debug → Objects
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
