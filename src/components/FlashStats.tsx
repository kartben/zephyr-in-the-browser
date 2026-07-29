/**
 * Stats strip + sector wear map for any {@link SpiFlashChip}.
 *
 * Pure consumer of `chip.decl` + `chip.stats()` — geometry, endurance, and
 * counters live on the chip so a denser NOR is a new declaration, not a new
 * panel. Compact mode is a utilisation bar and three tallies; the floating
 * window adds a sector map scaled against datasheet endurance when present.
 */

import { useEffect, useReducer } from 'react'
import { cn } from '@/lib/utils'
import { SectorGrid, selectedCellCount, type ByteRange } from '@/components/SectorGrid'
import {
  flashTotalErases,
  flashUsedFraction,
  formatFlashCount,
  formatFlashSize,
  type FlashStats,
  type SpiFlashChip,
} from '@/virtio/devices/flash/model'

const UI_MS = 50

function useFlashStats(chip: SpiFlashChip): FlashStats {
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

function wearFraction(erases: number, stats: FlashStats, endurance?: number): number {
  if (erases <= 0) return 0
  if (endurance && endurance > 0) return Math.min(1, erases / endurance)
  if (stats.maxSectorErases <= 0) return 0
  return Math.min(1, erases / stats.maxSectorErases)
}

/** Virgin / programmed / worn — colour encodes wear; programmed-but-never-erased is sky. */
function cellTone(erases: number, dirty: boolean, frac: number): string {
  if (erases <= 0) return dirty ? 'bg-sky-500/70' : 'bg-muted'
  if (frac < 0.25) return 'bg-emerald-500/80'
  if (frac < 0.5) return 'bg-lime-500/80'
  if (frac < 0.75) return 'bg-amber-400/90'
  if (frac < 0.95) return 'bg-orange-500/90'
  return 'bg-rose-500'
}

/** Byte range currently shown in the hex dump — sectors that overlap light up. */
export type FlashViewRange = ByteRange

export function FlashStatsView({
  chip,
  compact = false,
  onSectorClick,
  viewRange = null,
}: {
  chip: SpiFlashChip
  compact?: boolean
  /** Jump the hex window to this sector (full editor only). */
  onSectorClick?: (address: number) => void
  /** Highlight sectors overlapping the hex dump's visible range. */
  viewRange?: FlashViewRange | null
}) {
  const stats = useFlashStats(chip)
  const { size, sectorSize, enduranceCycles } = chip.decl
  const usedFrac = flashUsedFraction(stats, size)
  const usedPct = Math.round(usedFrac * 100)
  const totalErases = flashTotalErases(stats)

  return (
    <div className={cn('space-y-1.5', !compact && 'space-y-2')}>
      <div
        className="h-1.5 overflow-hidden rounded-sm bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedPct}
        aria-label="Flash utilisation"
      >
        <div
          className="h-full rounded-sm bg-sky-400/90 transition-[width] duration-150"
          style={{ width: `${usedPct}%` }}
        />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span title={`${stats.usedBytes.toLocaleString()} of ${size.toLocaleString()} bytes programmed`}>
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
        <span title={`${stats.programOps} program ops · ${stats.programBytes} bytes`}>
          <span className="text-foreground">{formatFlashCount(stats.programBytes)}</span> wr
        </span>
        <span
          title={`${stats.sectorErases} sector · ${stats.blockErases32k}×32K · ${stats.blockErases64k}×64K · ${stats.chipErases} chip`}
        >
          <span className="text-foreground">{formatFlashCount(totalErases)}</span> er
        </span>
        {!compact && (
          <span title={`${stats.dirtySectors} of ${stats.sectorCount} sectors`}>
            <span className="text-foreground">{stats.dirtySectors}</span>/{stats.sectorCount} sec
          </span>
        )}
        {!compact && (
          <button
            type="button"
            onClick={() => chip.resetStats()}
            title="Clear counters and wear map (keeps image)"
            className="ml-auto text-muted-foreground underline-offset-2 hover:underline"
          >
            reset stats
          </button>
        )}
      </div>

      {!compact && (
        <SectorWearMap
          stats={stats}
          sectorSize={sectorSize}
          enduranceCycles={enduranceCycles}
          onSectorClick={onSectorClick}
          viewRange={viewRange}
        />
      )}
    </div>
  )
}

function SectorWearMap({
  stats,
  sectorSize,
  enduranceCycles,
  onSectorClick,
  viewRange,
}: {
  stats: FlashStats
  sectorSize: number
  enduranceCycles?: number
  onSectorClick?: (address: number) => void
  viewRange?: FlashViewRange | null
}) {
  const scaleLabel = enduranceCycles
    ? `wear / ${formatFlashCount(enduranceCycles)} cycle rating`
    : 'wear relative to busiest sector'
  const selectedCount = selectedCellCount(viewRange, sectorSize, stats.sectorCount)

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
        <span>
          Sectors · {formatFlashSize(sectorSize)} each
          {onSectorClick ? ' · click to show in hex' : ''}
          {selectedCount > 0 ? (
            <span className="text-foreground">
              {' '}
              · {selectedCount === 1 ? '1 in view' : `${selectedCount} in view`}
            </span>
          ) : null}
        </span>
        <span className="font-mono tabular-nums">{scaleLabel}</span>
      </div>
      <SectorGrid
        count={stats.sectorCount}
        cellBytes={sectorSize}
        onCellClick={onSectorClick}
        viewRange={viewRange}
        ariaLabel={`Sector wear map, ${stats.sectorCount} sectors${selectedCount ? `, ${selectedCount} in hex view` : ''}`}
        cell={(si, selected) => {
          const erases = stats.sectorEraseCounts[si] ?? 0
          const used = stats.sectorUsedBytes[si] ?? 0
          const frac = wearFraction(erases, stats, enduranceCycles)
          const addr = si * sectorSize
          return {
            tone: cellTone(erases, used > 0, frac),
            label: `sector ${si} · 0x${addr.toString(16)} · ${used} B used · ${erases} erase${erases === 1 ? '' : 's'}${selected ? ' · in hex view' : ''}${onSectorClick ? ' — click to show in hex' : ''}`,
          }
        }}
      />
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
        {stats.maxSectorErases > 0 && (
          <span className="ml-auto">peak {stats.maxSectorErases}</span>
        )}
      </div>
    </div>
  )
}

/** Collapsed-row badge: utilisation when the image is non-blank, else capacity. */
export function FlashBadge({ chip }: { chip: SpiFlashChip }) {
  const stats = useFlashStats(chip)
  const usedPct = Math.round(flashUsedFraction(stats, chip.decl.size) * 100)
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
