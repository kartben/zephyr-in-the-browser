import { useCallback, useSyncExternalStore } from 'react'
import { CheckControl } from '@/components/controls/ControlRow'
import * as hostUart from '@/hostUart'
import { getInventory, revealDockRow, subscribeInventory } from '@/lib/dockReveal'
import { getSettings, subscribe as subscribeSerialSettings } from '@/lib/serialStore'
import { cn } from '@/lib/utils'
import { BAUD_RATES, DEFAULT_BAUD_RATE } from '@/serial/webSerial'
import type { DeviceNode } from '@/deviceTopology'

/**
 * A UART bus workbench: the same "On the bus" roster I²C/SPI expose, even
 * though a UART usually carries one child at a time (GNSS on uart1 today).
 * Roster rows navigate to the dock card for that peripheral. The UART the
 * emulator wires to the browser (uart1) can also be piped to a real serial
 * port, set up below the roster.
 */
export function UartBody({ busKey, pipe }: { busKey: string; pipe?: DeviceNode['uartPipe'] }) {
  const devices = useSyncExternalStore(
    subscribeInventory,
    useCallback(() => devicesOnBus(busKey), [busKey]),
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
                <code className="font-mono text-[11px] text-primary-text">{slotTag(device)}</code>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {device.label}
                </span>
                {/* Only the exception gets a tag, as on the I²C and SPI rosters. */}
                {device.presence !== 'interactive' && (
                  <span
                    className="whitespace-nowrap text-[10px] text-muted-foreground"
                    title="The devicetree declares this device, but the page has no controls for it."
                  >
                    listed only
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {pipe && <HostSerialPort defaultBaud={pipe.baudRate} />}
    </div>
  )
}

/**
 * Pipe this UART to a USB serial adapter through Web Serial (src/hostUart.ts).
 * The choice is saved, so the pipe reopens after a restart.
 */
function HostSerialPort({ defaultBaud }: { defaultBaud?: number }) {
  const pipe = useSyncExternalStore(hostUart.subscribe, hostUart.getSnapshot, hostUart.getSnapshot)
  const settings = useSyncExternalStore(subscribeSerialSettings, getSettings, getSettings)
  const saved = settings.uarts.uart1
  const baud = saved?.baudRate ?? defaultBaud ?? DEFAULT_BAUD_RATE
  const autoReconnect = saved?.autoReconnect ?? true
  const rates = BAUD_RATES.includes(baud as (typeof BAUD_RATES)[number])
    ? BAUD_RATES
    : [...BAUD_RATES, baud].sort((a, b) => a - b)

  const heading = (
    <span className="block text-[11px] font-medium text-muted-foreground">
      Pipe to a real serial port
    </span>
  )
  if (!pipe.supported) {
    return (
      <div className="space-y-1.5">
        {heading}
        <p className="text-[11px] text-muted-foreground">
          Piping needs Web Serial: Chrome, Edge or Firefox 151+.
        </p>
      </div>
    )
  }

  const { phase } = pipe
  const dot =
    phase === 'open'
      ? 'bg-success'
      : phase === 'opening'
        ? 'bg-warning animate-pulse'
        : 'bg-muted-foreground'
  const button =
    'rounded-md border border-input bg-secondary px-2 py-1 text-[11px] text-foreground hover:bg-background'

  return (
    <div className="space-y-1.5">
      {heading}
      {hostUart.ownsUart(phase) ? (
        <div className="flex items-center gap-2">
          <span
            className={cn('size-2 shrink-0 rounded-full', dot)}
            role="status"
            aria-label={`Serial port ${phase}`}
          />
          <span className="min-w-0 flex-1 break-words text-[11px] leading-snug text-foreground">
            {phase === 'waiting'
              ? `Waiting for ${pipe.portLabel}. Plug it in.`
              : phase === 'opening'
                ? `Opening ${pipe.portLabel}…`
                : `Piped to ${pipe.portLabel}`}
          </span>
          <button type="button" className={button} onClick={() => void hostUart.disconnect()}>
            {phase === 'waiting' ? 'Cancel' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={button}
          onClick={() => hostUart.chooseAndConnect(baud)}
        >
          Choose a port…
        </button>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={baud}
          aria-label="Baud rate"
          onChange={(e) => void hostUart.setBaudRate(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
        >
          {rates.map((rate) => (
            <option key={rate} value={rate}>
              {rate} baud
            </option>
          ))}
        </select>
        <span className="font-mono text-[11px] text-muted-foreground" title="8 data bits, no parity, 1 stop bit">
          8N1
        </span>
        <CheckControl
          label="Reconnect after restart"
          checked={autoReconnect}
          onChange={hostUart.setAutoReconnect}
        />
      </div>
      {phase === 'open' && (
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          <span title="Bytes from the port to the guest">rx {formatBytes(pipe.rx)}</span>
          {'  '}
          <span title="Bytes from the guest to the port">tx {formatBytes(pipe.tx)}</span>
          {pipe.dropped > 0 && (
            <span className="text-warning" title="Guest bytes dropped: the port could not keep up">
              {'  '}dropped {formatBytes(pipe.dropped)}
            </span>
          )}
        </p>
      )}
      {phase === 'error' && <p className="text-[11px] text-destructive">{pipe.error}</p>}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`
  return `${bytes} B`
}

const EMPTY: DeviceNode[] = []

/** Cache filtered children so useSyncExternalStore sees a stable snapshot. */
const cache = new Map<string, { inv: unknown; nodes: DeviceNode[] }>()

function devicesOnBus(busKey: string): DeviceNode[] {
  const inv = getInventory()
  const hit = cache.get(busKey)
  if (hit && hit.inv === inv) return hit.nodes
  const nodes = inv?.nodes.filter((n) => n.parentKey === busKey) ?? EMPTY
  const stable = nodes.length === 0 ? EMPTY : nodes
  cache.set(busKey, { inv, nodes: stable })
  return stable
}

/** Short roster tag — GNSS has no address/CS, so use a stable role label. */
function slotTag(device: DeviceNode): string {
  if (device.body === 'gnss' || device.deviceClass === 'gnss') return 'NMEA'
  return device.nodeName.split('@')[0] || device.nodeName
}
