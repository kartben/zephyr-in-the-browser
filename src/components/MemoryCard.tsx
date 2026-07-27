import { useCallback, useState } from 'react'
import { FlashStatsView } from '@/components/FlashStats'
import { HexPreview } from '@/components/HexPreview'
import { HexView, type HexJump, type HexViewRange } from '@/components/HexView'
import { LittlefsBrowserButton } from '@/components/LittlefsBrowser'
import { MemoryStatsView } from '@/components/MemoryStats'
import type { MemoryChip } from '@/virtio/devices/memory/model'
import { formatFlashSize, type SpiFlashChip } from '@/virtio/devices/flash/model'

/**
 * The control surface for a simulated I2C memory part.
 *
 * The counterpart of SensorCard: a sensor's state is a handful of channels, so
 * its card is sliders; a memory's state *is* its contents, so its card is a hex
 * dump (HexView) and little else. Everything it needs comes from the chip's
 * declaration, so a second EEPROM is a declaration rather than another panel.
 *
 * Like the sensor cards this is a *device*, and lives on the devices edge — the
 * bus it rides is the I2C panel's business.
 */
/**
 * The hex dump and its trimmings without the frame. Two densities: `compact`
 * (the dock row) shows a two-row pointer-following preview with a "Hex editor"
 * hand-off to a floating window; full (the window) is the whole editable dump.
 */
export function MemoryBody({
  chip,
  compact = false,
  onOpenWindow,
}: {
  chip: MemoryChip
  compact?: boolean
  /** Compact mode's "Hex editor" button — pops the full editor out. */
  onOpenWindow?: () => void
}) {
  const { size, pageSize } = chip.decl

  return (
    <div className={compact ? 'space-y-1.5 px-3 py-2.5' : 'space-y-2 px-3 py-3'}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatFlashSize(size)}
          {pageSize ? ` · ${pageSize} B pages` : ''}
        </span>
        {compact && onOpenWindow && (
          <button
            onClick={onOpenWindow}
            className="ml-auto text-[10px] text-primary underline-offset-2 hover:underline"
          >
            Hex editor ⧉
          </button>
        )}
        <button
          onClick={() => chip.erase()}
          title="Clear every cell (and any saved contents)"
          className={
            compact && onOpenWindow
              ? 'text-[10px] text-muted-foreground underline-offset-2 hover:underline'
              : 'ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline'
          }
        >
          erase
        </button>
      </div>

      <MemoryStatsView chip={chip} compact={compact} />

      {compact ? <HexPreview chip={chip} /> : <HexView chip={chip} />}
    </div>
  )
}

/**
 * Hex surface + live flash stats for any {@link SpiFlashChip}. Geometry and
 * counters come from the chip declaration/machine — a second NOR density is
 * another decl, not another body.
 */
export function SpiFlashBody({
  chip,
  compact = false,
  onOpenWindow,
}: {
  chip: SpiFlashChip
  compact?: boolean
  onOpenWindow?: () => void
}) {
  const { size, pageSize, sectorSize } = chip.decl
  const [hexJump, setHexJump] = useState<HexJump | null>(null)
  const [hexRange, setHexRange] = useState<HexViewRange | null>(null)
  const onHexViewChange = useCallback((range: HexViewRange) => {
    setHexRange((prev) =>
      prev && prev.start === range.start && prev.end === range.end ? prev : range,
    )
  }, [])

  return (
    <div className={compact ? 'space-y-1.5 px-3 py-2.5' : 'space-y-2 px-3 py-3'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatFlashSize(size)}
          {pageSize ? ` · ${pageSize} B pages` : ''}
          {sectorSize ? ` · ${formatFlashSize(sectorSize)} sectors` : ''}
          {' · '}
          CS{chip.cs}
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <LittlefsBrowserButton chip={chip} />
          {compact && onOpenWindow && (
            <button
              onClick={onOpenWindow}
              className="text-[10px] text-primary underline-offset-2 hover:underline"
            >
              Hex editor ⧉
            </button>
          )}
          <button
            onClick={() => chip.erase()}
            title="Clear every cell (and any saved contents)"
            className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          >
            erase
          </button>
        </span>
      </div>

      <FlashStatsView
        chip={chip}
        compact={compact}
        viewRange={compact ? null : hexRange}
        onSectorClick={
          compact
            ? undefined
            : (address) => setHexJump({ address, token: Date.now() })
        }
      />

      {compact ? (
        <HexPreview chip={chip} />
      ) : (
        <HexView chip={chip} jump={hexJump} onViewChange={onHexViewChange} />
      )}
    </div>
  )
}
