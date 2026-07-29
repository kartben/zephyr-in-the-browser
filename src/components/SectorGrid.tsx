/**
 * A grid of one cell per block of a storage medium.
 *
 * The mechanics — fluid column count, square cells, click-to-hex, and the ring
 * marking what the hex dump is showing — are the same whether the medium is
 * SPI NOR (`FlashStats`, where a cell is an erase sector coloured by wear) or a
 * virtio-blk image (`DiskPanel`, where a cell is a block that either holds data
 * or does not). What differs is only the colour and the caption, so callers
 * supply those per cell.
 */

import { useFluidCols } from '@/hooks/useFluidCols'
import { cn } from '@/lib/utils'

/** Byte range currently shown in the hex dump — cells that overlap light up. */
export type ByteRange = { start: number; end: number }

export interface SectorCell {
  /** Tailwind background class for this cell. */
  tone: string
  /** Tooltip and accessible name. */
  label: string
}

export function SectorGrid({
  count,
  cellBytes,
  cell,
  ariaLabel,
  onCellClick,
  viewRange = null,
}: {
  count: number
  /** Bytes covered by one cell, used to map `viewRange` onto cells. */
  cellBytes: number
  cell: (index: number, selected: boolean) => SectorCell
  ariaLabel: string
  onCellClick?: (address: number) => void
  viewRange?: ByteRange | null
}) {
  const { ref: gridRef, cols } = useFluidCols(count)

  const viewFirst =
    viewRange && viewRange.end > viewRange.start
      ? Math.max(0, Math.floor(viewRange.start / cellBytes))
      : -1
  const viewLast =
    viewFirst >= 0 && viewRange ? Math.min(count - 1, Math.floor((viewRange.end - 1) / cellBytes)) : -1

  return (
    <div
      ref={gridRef}
      className="grid w-full gap-px rounded-sm bg-border/60 p-px"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      role="img"
      aria-label={ariaLabel}
    >
      {Array.from({ length: count }, (_, i) => {
        const selected = i >= viewFirst && i <= viewLast
        const { tone, label } = cell(i, selected)
        const className = cn(
          'aspect-square min-h-0 w-full rounded-[1px]',
          tone,
          selected && 'relative z-[1] shadow-[0_0_0_2px_var(--primary)]',
        )
        if (onCellClick) {
          return (
            <button
              key={i}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={selected}
              onClick={() => onCellClick(i * cellBytes)}
              className={cn(
                className,
                'cursor-pointer hover:brightness-110',
                !selected &&
                  'hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_60%,transparent)]',
              )}
            />
          )
        }
        return <div key={i} title={label} className={className} />
      })}
    </div>
  )
}

/** How many cells the hex view is currently showing, for a caption. */
export function selectedCellCount(
  viewRange: ByteRange | null | undefined,
  cellBytes: number,
  count: number,
): number {
  if (!viewRange || viewRange.end <= viewRange.start) return 0
  const first = Math.max(0, Math.floor(viewRange.start / cellBytes))
  const last = Math.min(count - 1, Math.floor((viewRange.end - 1) / cellBytes))
  return last >= first ? last - first + 1 : 0
}
