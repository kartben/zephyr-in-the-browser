import { useCallback, useState, useSyncExternalStore } from 'react'
import { FlashStatsView } from '@/components/FlashStats'
import { HexPreview } from '@/components/HexPreview'
import { HexView, type HexJump } from '@/components/HexView'
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

      {!compact && <Hints chip={chip} />}
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
        onSectorClick={
          compact
            ? undefined
            : (address) => setHexJump({ address, token: Date.now() })
        }
      />

      {compact ? <HexPreview chip={chip} /> : <HexView chip={chip} jump={hexJump} />}

      {!compact && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          In the guest:{' '}
          <code className="font-mono text-foreground">
            flash read {chip.decl.shellLabel ?? 'w25q80jv@0'} 0 16
          </code>
          {' · '}
          <code className="font-mono text-foreground">fs mount littlefs /lfs</code>
          {' · '}
          <code className="font-mono text-foreground">fs ls /lfs</code>
          {' · click a hex byte to edit · click a sector to jump the dump'}
        </p>
      )}
    </div>
  )
}

/** What to type in the guest to see the same bytes from the other side. */
function Hints({ chip }: { chip: MemoryChip }) {
  const hex = chip.address.toString(16).padStart(2, '0')
  // Read the pointer through the store so the offset in the hint tracks where
  // the guest actually is, rather than being a static example.
  const pointer = useSyncExternalStore(
    chip.subscribe,
    useCallback(() => chip.pointer(), [chip]),
    useCallback(() => 0, []),
  )
  const at = pointer.toString(16).padStart(2, '0')

  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      In the guest:{' '}
      <code className="font-mono text-foreground">
        i2c read virtio_i2c0 {hex} {at} 8
      </code>{' '}
      reads eight bytes from 0x{at}
      {chip.decl.shellLabel && (
        <>
          ,{' '}
          <code className="font-mono text-foreground">
            eeprom write {chip.decl.shellLabel} 0x{at} de ad
          </code>{' '}
          writes through the EEPROM API — either way the bytes above move.
        </>
      )}
      {!chip.decl.shellLabel && '.'}
    </p>
  )
}
