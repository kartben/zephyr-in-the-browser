/**
 * The Simulation readout, shrunk to what it is: one number. A small pill on
 * the stage shows live guest MIPS; clicking it unfolds the sparkline and peak
 * it used to spend a whole panel on. It is a machine property (the -icount
 * counter), not a devicetree node, so it lives outside the dock — the Panels
 * menu can hide it, and that choice persists like any other.
 */

import { useSyncExternalStore } from 'react'
import { Gauge } from 'lucide-react'
import { Sparkline } from '@/components/Sparkline'
import { cn } from '@/lib/utils'
import { getSnapshot, subscribe } from '@/guestStats'
import {
  STAGE_PERF_KEY,
  effectiveExpandedIn,
  getState,
  setExpanded,
  subscribe as subscribeDock,
} from '@/lib/dockStore'

export function StagePill() {
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)

  if (!stats.available || dock.devices[STAGE_PERF_KEY]?.hidden) return null

  const expanded = effectiveExpandedIn(dock, STAGE_PERF_KEY, 'perf')

  return (
    <div className="pointer-events-auto">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Guest throughput ${formatMips(stats.mips)} million instructions per second`}
        onClick={() => setExpanded(STAGE_PERF_KEY, !expanded)}
        className={cn(
          'flex items-center gap-1.5 border border-border bg-card/90 shadow-lg backdrop-blur',
          'font-mono text-[11px] tabular-nums text-foreground hover:border-primary/60',
          expanded ? 'rounded-t-lg rounded-b-none border-b-0 px-2.5 py-1' : 'rounded-full px-2.5 py-1',
        )}
      >
        <Gauge className="size-3 text-primary" aria-hidden />
        {formatMips(stats.mips)} MIPS
      </button>
      {expanded && (
        <div className="w-56 rounded-b-lg rounded-tr-lg border border-border bg-card/95 p-2.5 shadow-lg backdrop-blur">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-xl font-semibold tabular-nums">
              {formatMips(stats.mips)}
            </span>
            <span className="text-[11px] text-muted-foreground">MIPS</span>
            {stats.peakMips > 0 && (
              <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
                peak {formatMips(stats.peakMips)}
              </span>
            )}
          </div>
          <Sparkline
            values={stats.history}
            className="mt-1.5 text-primary"
            height={28}
            ariaLabel="Recent guest throughput"
          />
          <p className="pt-1.5 text-[10px] leading-relaxed text-muted-foreground">
            Guest instructions retired per second, read from the wasm JIT through{' '}
            <code className="font-mono text-foreground">-icount</code>.
          </p>
        </div>
      )}
    </div>
  )
}

/** Guest throughput in millions of instructions/second, sized for a glance. */
function formatMips(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}
