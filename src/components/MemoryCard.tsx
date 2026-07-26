import { useCallback, useSyncExternalStore } from 'react'
import { HexPreview } from '@/components/HexPreview'
import { HexView } from '@/components/HexView'
import { LittlefsBrowserButton } from '@/components/LittlefsBrowser'
import type { MemoryChip } from '@/virtio/devices/memory/model'
import type { SpiFlashChip } from '@/virtio/devices/chips/w25q'

/** Hex dump for a memory chip. `compact` is the dock preview; full is the window. */
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
          {size} B{pageSize ? ` · ${pageSize} B pages` : ''}
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

      {compact ? <HexPreview chip={chip} /> : <HexView chip={chip} />}

      {!compact && <Hints chip={chip} />}
    </div>
  )
}

/** Same hex surface for a JEDEC SPI NOR on the virtio-spi bus. */
export function SpiFlashBody({
  chip,
  compact = false,
  onOpenWindow,
}: {
  chip: SpiFlashChip
  compact?: boolean
  onOpenWindow?: () => void
}) {
  const { size, pageSize } = chip.decl

  return (
    <div className={compact ? 'space-y-1.5 px-3 py-2.5' : 'space-y-2 px-3 py-3'}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          {size} B{pageSize ? ` · ${pageSize} B pages` : ''} · CS{chip.cs}
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

      {compact ? <HexPreview chip={chip} /> : <HexView chip={chip} />}

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
