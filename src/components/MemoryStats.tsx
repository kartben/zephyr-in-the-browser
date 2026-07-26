/**
 * Stats strip + page wear map for any {@link MemoryChip}.
 *
 * Lighter sibling of the SPI NOR stats view: EEPROMs have page writes, not
 * sector erases. Utilisation + rd/wr always; the page map only when the decl
 * names a pageSize. Pure consumer of `chip.decl` + `chip.stats()`.
 */

import { useEffect, useReducer } from 'react'
import { cn } from '@/lib/utils'
import { formatFlashCount, formatFlashSize } from '@/virtio/devices/flash/model'
import {
  memoryUsedFraction,
  type MemoryChip,
  type MemoryStats,
} from '@/virtio/devices/memory/model'

const UI_MS = 50

function useMemoryStats(chip: MemoryChip): MemoryStats {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    refresh()
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
  return chip.stats()
}

function wearFraction(writes: number, stats: MemoryStats, endurance?: number): number {
  if (writes <= 0) return 0
  if (endurance && endurance > 0) return Math.min(1, writes / endurance)
  if (stats.maxPageWrites <= 0) return 0
  return Math.min(1, writes / stats.maxPageWrites)
}

function cellTone(writes: number, dirty: boolean, frac: number): string {
  if (writes <= 0) return dirty ? 'bg-sky-500/70' : 'bg-muted'
  if (frac < 0.25) return 'bg-emerald-500/80'
  if (frac < 0.5) return 'bg-lime-500/80'
  if (frac < 0.75) return 'bg-amber-400/90'
  if (frac < 0.95) return 'bg-orange-500/90'
  return 'bg-rose-500'
}

export function MemoryStatsView({
  chip,
  compact = false,
}: {
  chip: MemoryChip
  compact?: boolean
}) {
  const stats = useMemoryStats(chip)
  const { size, pageSize, enduranceCycles } = chip.decl
  const usedPct = Math.round(memoryUsedFraction(stats, size) * 100)

  return (
    <div className={cn('space-y-1.5', !compact && 'space-y-2')}>
      <div
        className="h-1.5 overflow-hidden rounded-sm bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPct}
        aria-label="EEPROM utilisation"
      >
        <div
          className="h-full rounded-sm bg-sky-400/90 transition-[width] duration-150"
          style={{ width: `${usedPct}%` }}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span title={`${stats.usedBytes.toLocaleString()} of ${size.toLocaleString()} bytes written`}>
          <span className="text-foreground">{usedPct}%</span> used
          {!compact && (
            <span className="text-muted-foreground/70">
              {' '}
              · {formatFlashCount(stats.usedBytes)} / {formatFlashSize(size)}
            </span>
          )}
        </span>
        <span title={`${stats.readOps} read ops · ${stats.readBytes} bytes`}>
          <span className="text-foreground">{formatFlashCount(stats.readBytes)}</span> rd
        </span>
        <span title={`${stats.writeOps} write ops · ${stats.writeBytes} bytes`}>
          <span className="text-foreground">{formatFlashCount(stats.writeBytes)}</span> wr
        </span>
        {!compact && pageSize != null && stats.pageCount > 0 && (
          <span title={`${stats.dirtyPages} of ${stats.pageCount} pages`}>
            <span className="text-foreground">{stats.dirtyPages}</span>/{stats.pageCount} pg
          </span>
        )}
        {!compact && (
          <button
            type="button"
            onClick={() => chip.resetStats()}
            title="Clear session counters and page wear (keeps image)"
            className="ml-auto text-muted-foreground underline-offset-2 hover:underline"
          >
            reset stats
          </button>
        )}
      </div>

      {!compact && pageSize != null && stats.pageCount > 0 && (
        <PageWearMap
          stats={stats}
          pageSize={pageSize}
          enduranceCycles={enduranceCycles}
        />
      )}
    </div>
  )
}

function PageWearMap({
  stats,
  pageSize,
  enduranceCycles,
}: {
  stats: MemoryStats
  pageSize: number
  enduranceCycles?: number
}) {
  const cols = Math.max(8, Math.min(32, Math.round(Math.sqrt(stats.pageCount))))
  const scaleLabel = enduranceCycles
    ? `wear / ${formatFlashCount(enduranceCycles)} cycle rating`
    : 'wear relative to busiest page this session'

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
        <span>Pages · {pageSize} B each</span>
        <span className="font-mono tabular-nums">{scaleLabel}</span>
      </div>
      <div
        className="grid gap-px rounded-sm bg-border/60 p-px"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        role="img"
        aria-label={`Page wear map, ${stats.pageCount} pages`}
      >
        {Array.from({ length: stats.pageCount }, (_, pi) => {
          const writes = stats.pageWriteCounts[pi] ?? 0
          const used = stats.pageUsedBytes[pi] ?? 0
          const dirty = used > 0
          const frac = wearFraction(writes, stats, enduranceCycles)
          const addr = pi * pageSize
          return (
            <div
              key={pi}
              title={`page ${pi} · 0x${addr.toString(16)} · ${used} B used · ${writes} write${writes === 1 ? '' : 's'}`}
              className={cn('aspect-square min-h-[5px] rounded-[1px]', cellTone(writes, dirty, frac))}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-muted" /> erased
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-sky-500/70" /> data
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-emerald-500/80" /> low wear
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-amber-400/90" /> mid
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-[1px] bg-rose-500" /> high
        </span>
        {stats.maxPageWrites > 0 && (
          <span className="ml-auto">peak {stats.maxPageWrites}</span>
        )}
      </div>
    </div>
  )
}

/** Collapsed-row badge: utilisation when non-blank, else capacity. */
export function MemoryBadge({ chip }: { chip: MemoryChip }) {
  const stats = useMemoryStats(chip)
  const usedPct = Math.round(memoryUsedFraction(stats, chip.decl.size) * 100)
  if (stats.usedBytes > 0) {
    return (
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {usedPct}% · {formatFlashSize(chip.decl.size)}
      </span>
    )
  }
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {formatFlashSize(chip.decl.size)}
    </span>
  )
}
