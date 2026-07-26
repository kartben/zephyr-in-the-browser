import { useCallback, useSyncExternalStore } from 'react'
import { getInventory, revealDockRow, subscribeInventory } from '@/lib/dockReveal'
import type { DeviceNode } from '@/deviceTopology'

/**
 * A UART bus workbench — the same "On the bus" roster I²C/SPI expose, even
 * though a UART usually carries one child at a time (GNSS on uart1 today).
 * Roster rows navigate to the dock card for that peripheral; there is no
 * attach picker yet because page-side UART parts are still a short list.
 */
export function UartBody({
  busKey,
  busLabel = 'uart1',
}: {
  busKey: string
  busLabel?: string
}) {
  const devices = useSyncExternalStore(
    subscribeInventory,
    () => getInventory()?.nodes.filter((n) => n.parentKey === busKey) ?? EMPTY,
    useCallback(() => EMPTY, []),
  )

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">On the bus</span>
        <ul className="space-y-1">
          {devices.length === 0 && (
            <li className="text-[11px] text-muted-foreground">Nothing attached.</li>
          )}
          {devices.map((device) => (
            <li
              key={device.key}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-90"
                title={`Reveal ${device.label} in the dock`}
                onClick={() => revealDockRow(device.key, device.deviceClass)}
              >
                <code className="font-mono text-[11px] text-primary">{slotTag(device)}</code>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {device.label}
                </span>
                {device.presence === 'interactive' ? (
                  <span
                    className="text-[10px] text-emerald-400"
                    title="The guest has a driver for this UART child"
                  >
                    driver
                  </span>
                ) : (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title="Declared on the UART, but nothing answers yet"
                  >
                    bus only
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        In the guest: children of <code className="font-mono text-foreground">{busLabel}</code>{' '}
        are UART peripherals (today: NMEA GNSS). One at a time is normal —
        the roster stays so the bus looks like I²C and SPI.
      </p>
    </div>
  )
}

const EMPTY: DeviceNode[] = []

/** Short roster tag — GNSS has no address/CS, so use a stable role label. */
function slotTag(device: DeviceNode): string {
  if (device.body === 'gnss' || device.deviceClass === 'gnss') return 'NMEA'
  return device.nodeName.split('@')[0] || device.nodeName
}
