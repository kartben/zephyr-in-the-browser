import { useCallback, useSyncExternalStore } from 'react'
import { MemoryStick } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { HexView } from '@/components/HexView'
import type { MemoryChip } from '@/virtio/devices/memory/model'

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
export function MemoryCard({
  chip,
  defaultExpanded = true,
}: {
  chip: MemoryChip
  defaultExpanded?: boolean
}) {
  const hex = chip.address.toString(16).padStart(2, '0')
  const { size, pageSize } = chip.decl

  return (
    <PanelFrame
      id={`memory:${hex}`}
      title={chip.name}
      icon={MemoryStick}
      side="right"
      // A 16-byte dump plus its offset and ASCII gutters needs the width; the
      // body scrolls sideways rather than wrapping if the panel is narrower.
      dockedWidth={27}
      defaultExpanded={defaultExpanded}
      status={<span className="font-mono text-[10px] text-muted-foreground">I2C · 0x{hex}</span>}
    >
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {size} B{pageSize ? ` · ${pageSize} B pages` : ''}
          </span>
          <button
            onClick={() => chip.erase()}
            className="ml-auto text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          >
            erase
          </button>
        </div>

        <HexView chip={chip} />

        <Hints chip={chip} />
      </div>
    </PanelFrame>
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
