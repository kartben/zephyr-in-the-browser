import { useState, useSyncExternalStore } from 'react'
import { ChevronDown, Gauge, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sparkline } from '@/components/Sparkline'
import { cn } from '@/lib/utils'
import { getSnapshot, subscribe } from '@/guestStats'

/**
 * Live guest-throughput readout in MIPS, from the icount export on the aarch64
 * JIT build. Hidden entirely unless that export is present and advancing, so it
 * only shows on the Cortex-A53 (`-icount`) board and never as dead UI.
 */
export function PerformancePanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const stats = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(!defaultExpanded)
  const [dismissed, setDismissed] = useState(false)

  if (!stats.available || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <Gauge className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">Simulation</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand simulation stats' : 'Collapse simulation stats'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide simulation panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
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
      )}
    </div>
  )
}

/** Guest throughput in millions of instructions/second, sized for a glance. */
function formatMips(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}
