import { useSyncExternalStore } from 'react'
import { Gauge } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { Sparkline } from '@/components/Sparkline'
import { getSnapshot, subscribe } from '@/guestStats'

/**
 * Live guest-throughput readout in MIPS, from the icount export on the aarch64
 * JIT build. Hidden entirely unless that export is present and advancing, so it
 * only shows on the Cortex-A53 (`-icount`) board and never as dead UI.
 */
export function PerformancePanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!stats.available) return null

  return (
    <PanelFrame id="perf" title="Simulation" icon={Gauge} defaultExpanded={defaultExpanded}>
      <div className="px-3 py-3">
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-mono text-2xl font-semibold tabular-nums"
            aria-label={`Guest throughput ${formatMips(stats.mips)} million instructions per second`}
          >
            {formatMips(stats.mips)}
          </span>
          <span className="text-xs text-muted-foreground">MIPS</span>
          {stats.peakMips > 0 && (
            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
              peak {formatMips(stats.peakMips)}
            </span>
          )}
        </div>

        <Sparkline
          values={stats.history}
          className="mt-2 text-primary"
          ariaLabel="Recent guest throughput"
        />

        <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">
          Guest instructions retired per second, read from the wasm JIT through{' '}
          <code className="font-mono text-foreground">-icount</code>.
        </p>
      </div>
    </PanelFrame>
  )
}

/** Guest throughput in millions of instructions/second, sized for a glance. */
function formatMips(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}
