import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { FlashStatsView } from '@/components/FlashStats'
import { HexPreview } from '@/components/HexPreview'
import { HexView, type HexJump, type HexViewRange } from '@/components/HexView'
import { LittlefsBrowserButton } from '@/components/LittlefsBrowser'
import { useZmsVolumes, ZmsBrowserButton } from '@/components/ZmsBrowser'
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
            className="ml-auto text-[10px] text-primary-text underline-offset-2 hover:underline"
          >
            Hex editor ⧉
          </button>
        )}
        <EraseControl
          size={size}
          onErase={() => chip.erase()}
          className={compact && onOpenWindow ? undefined : 'ml-auto'}
        />
      </div>

      <MemoryStatsView chip={chip} compact={compact} />

      {compact ? <HexPreview chip={chip} /> : <HexView chip={chip} />}
    </div>
  )
}

/**
 * The erase link, with a confirm step in place. One click used to wipe the
 * whole part, saved contents too, and nothing could bring them back; a stray
 * click beside "Hex editor" was enough. Now the link turns into "Erase all
 * 8 KiB? Erase · Cancel" on the same line, Cancel holding the focus so Enter
 * and Escape both back out.
 */
export function EraseControl({
  size,
  onErase,
  className,
}: {
  size: number
  onErase: () => void
  className?: string
}) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        title="Clear every cell (and any saved contents)"
        className={cn(
          'text-[10px] text-muted-foreground underline-offset-2 hover:underline',
          className,
        )}
      >
        erase
      </button>
    )
  }

  return (
    <span
      role="group"
      aria-label="Confirm erase"
      className={cn('flex items-baseline gap-2 text-[10px]', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setConfirming(false)
      }}
    >
      <span className="text-foreground">Erase all {formatFlashSize(size)}?</span>
      <button
        onClick={() => {
          setConfirming(false)
          onErase()
        }}
        title="Clear every cell (and any saved contents). This cannot be undone."
        className="font-medium text-destructive underline-offset-2 hover:underline"
      >
        Erase
      </button>
      <button
        autoFocus
        onClick={() => setConfirming(false)}
        className="text-muted-foreground underline-offset-2 hover:underline"
      >
        Cancel
      </button>
    </span>
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
  const zms = useZmsVolumes(chip)
  // A chip that holds ZMS and no LittleFS has nothing for the Filesystem view.
  const showFilesystem = zms.volumes.length === 0 || zms.littlefs
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
        {/* No CS here: the identity line just above wears it, with its live
            dot, and the row's breadcrumb names it too. */}
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatFlashSize(size)}
          {pageSize ? ` · ${pageSize} B pages` : ''}
          {sectorSize ? ` · ${formatFlashSize(sectorSize)} sectors` : ''}
        </span>
        <span className="ml-auto flex items-baseline gap-3">
          <ZmsBrowserButton chip={chip} volumes={zms.volumes} />
          {showFilesystem && <LittlefsBrowserButton chip={chip} />}
          {compact && onOpenWindow && (
            <button
              onClick={onOpenWindow}
              className="text-[10px] text-primary-text underline-offset-2 hover:underline"
            >
              Hex editor ⧉
            </button>
          )}
          <EraseControl size={size} onErase={() => chip.erase()} />
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
