import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import * as ipcUi from '@/lib/ipcUi'
import { ipcKindCounts } from './filter'
import { isSyncKind, type FlowNodeSpec } from './model'
import { SYNC_STYLE } from './QueueGraphCanvas'

/**
 * The IPC graph's filter row: a name filter, one chip per object kind present,
 * a chip for the locks and signals only one thread uses, and the focus, when
 * there is one, as a chip that lets go of it.
 *
 * Kind chips only show when there are two kinds or more: a lone chip could only
 * hide the whole graph.
 */
export function IpcFilterBar({
  nodes,
  filter,
  focused,
  privateCount = 0,
}: {
  /** Every node before the filter. */
  nodes: FlowNodeSpec[]
  filter: ipcUi.IpcFilter
  /** The focus names a node that is in the graph. */
  focused: boolean
  /** Semaphores, mutexes and condvars only one thread or ISR uses. */
  privateCount?: number
}) {
  const kinds = [...ipcKindCounts(nodes)]
  const focusLabel = focused ? nodes.find((node) => node.id === filter.focus)?.label : undefined

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 bg-slate-900/30 px-3 py-1.5 text-[10px] text-slate-400">
      <label className="relative min-w-24 flex-1">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-slate-500"
          aria-hidden
        />
        <input
          value={filter.query}
          onChange={(event) => ipcUi.setIpcQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter.query) {
              event.stopPropagation()
              ipcUi.setIpcQuery('')
            }
          }}
          placeholder="Filter by name"
          aria-label="Filter the IPC graph by thread or object name"
          className="h-6 w-full rounded-md border border-border/60 bg-slate-950/60 pl-6 pr-2 font-mono text-[10px] text-slate-200 outline-none placeholder:text-slate-500 focus:border-primary/50"
        />
      </label>
      {kinds.length > 1 &&
        kinds.map(([kind, count]) => {
          const hidden = filter.hiddenKinds.has(kind)
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={!hidden}
              title={hidden ? `Show ${kind} objects` : `Hide ${kind} objects`}
              onClick={() => ipcUi.toggleIpcKind(kind)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono tabular-nums touch-manipulation',
                hidden
                  ? 'border-border/40 text-slate-500 line-through'
                  : 'border-slate-600 bg-slate-800/70 text-slate-200 hover:bg-slate-700/70',
              )}
            >
              {isSyncKind(kind) && (
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: SYNC_STYLE[kind].stroke }}
                  aria-hidden
                />
              )}
              {kind} {count}
            </button>
          )
        })}
      {privateCount > 0 && (
        <button
          type="button"
          aria-pressed={filter.showPrivate}
          title={
            filter.showPrivate
              ? 'Hide the semaphores, mutexes and condvars only one thread uses'
              : 'Show the semaphores, mutexes and condvars only one thread uses'
          }
          onClick={ipcUi.toggleIpcPrivate}
          className={cn(
            'rounded-full border px-2 py-0.5 font-mono tabular-nums touch-manipulation',
            filter.showPrivate
              ? 'border-slate-600 bg-slate-800/70 text-slate-200 hover:bg-slate-700/70'
              : 'border-dashed border-slate-600 text-slate-400 hover:text-slate-200',
          )}
        >
          {filter.showPrivate ? '' : '+'}
          {privateCount} private
        </button>
      )}
      {focusLabel !== undefined && (
        <button
          type="button"
          title="Show the whole graph"
          aria-label={`Show the whole graph, not just ${focusLabel}`}
          onClick={() => ipcUi.setIpcFocus(null)}
          className="flex items-center gap-1 rounded-full border border-sky-400/40 bg-sky-400/10 px-2 py-0.5 font-mono text-sky-200 touch-manipulation hover:bg-sky-400/20"
        >
          {focusLabel}
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
