/**
 * The Simulation readout, shrunk to what it is: one number. The dock row's
 * badge carries live guest MIPS; expanding adds the sparkline and the peak.
 * It is a machine property (the -icount counter), not a devicetree node, which
 * is why it sits in the dock's Instruments section rather than among devices.
 */

import { useSyncExternalStore } from 'react'
import { Sparkline } from '@/components/Sparkline'
import { getSnapshot, subscribe } from '@/guestStats'

export function SimulationBadge() {
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {formatMips(stats.mips)} MIPS
    </span>
  )
}

export function SimulationBody() {
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return (
    <div className="px-2.5 py-2">
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
      <p
        className="pt-1.5 text-[10px] leading-relaxed text-muted-foreground"
        title="Guest instructions retired per second"
      >
        How fast the guest is running — instructions per second.
      </p>
    </div>
  )
}

/** Guest throughput in millions of instructions/second, sized for a glance. */
function formatMips(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}
