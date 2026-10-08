import { useSyncExternalStore } from 'react'
import { CheckControl, NumberControl } from '@/components/controls/ControlRow'
import {
  followingBrowser,
  getSnapshot,
  locationError,
  setFix,
  setFollowBrowser,
  subscribe,
  type GnssFix,
} from '@/hostGnss'
import * as hostUart from '@/hostUart'
import { revealDockRow } from '@/lib/dockReveal'
import { getSettings, subscribe as subscribeSerialSettings } from '@/lib/serialStore'

const FIELDS: Array<{
  key: keyof GnssFix
  label: string
  unit: string
  step: number
  min: number
  max: number
}> = [
  { key: 'latitude', label: 'Latitude', unit: '°', step: 0.0001, min: -90, max: 90 },
  { key: 'longitude', label: 'Longitude', unit: '°', step: 0.0001, min: -180, max: 180 },
  { key: 'altitude', label: 'Altitude', unit: 'm', step: 1, min: -1000, max: 100000 },
  { key: 'speed', label: 'Speed', unit: 'm/s', step: 0.1, min: 0, max: 2000 },
  { key: 'bearing', label: 'Bearing', unit: '°', step: 1, min: 0, max: 359 },
  { key: 'satellites', label: 'Satellites', unit: '', step: 1, min: 0, max: 99 },
]

/** NMEA receivers ship at 9600 baud almost without exception. */
const RECEIVER_BAUD = 9600

/**
 * The fix editor for the NMEA stream, shared by the dock row and the window.
 * `busKey` is the dock row of the UART it hangs off, whose card holds the
 * serial-port pipe a real receiver plugs in through.
 */
export function GnssBody({ busKey }: { busKey?: string }) {
  const fix = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Lives in hostGnss so the geolocation watch survives this body unmounting.
  const live = useSyncExternalStore(subscribe, followingBrowser, () => false)
  const watchError = useSyncExternalStore(subscribe, locationError, () => '')
  const pipe = useSyncExternalStore(hostUart.subscribe, hostUart.getSnapshot, hostUart.getSnapshot)
  const serial = useSyncExternalStore(subscribeSerialSettings, getSettings, getSettings)
  const piped = hostUart.ownsUart(pipe.phase)
  const link = 'text-primary-text underline-offset-2 hover:underline'

  return (
    <div className="space-y-1 px-3 py-2.5">
      {piped ? (
        <p className="pb-1 text-[11px] text-muted-foreground">
          {pipe.phase === 'waiting'
            ? `uart1 is waiting for ${pipe.portLabel}; simulated fix paused. `
            : `uart1 is piped to ${pipe.portLabel}; simulated fix paused. `}
          {busKey && (
            <button
              type="button"
              className={link}
              onClick={() => revealDockRow(busKey, 'uart-bus')}
            >
              Port settings
            </button>
          )}
        </p>
      ) : (
        pipe.available &&
        pipe.supported && (
          <p className="pb-1 text-[11px] text-muted-foreground">
            Have a real receiver?{' '}
            <button
              type="button"
              className={link}
              onClick={() =>
                hostUart.chooseAndConnect(serial.uarts.uart1?.baudRate ?? RECEIVER_BAUD)
              }
            >
              Pipe uart1 to it…
            </button>
          </p>
        )
      )}
      <div className="flex flex-wrap gap-1.5 pb-1">
        <CheckControl label="Follow browser location" checked={live} onChange={setFollowBrowser} />
      </div>

      {watchError && <p className="text-[11px] text-destructive">{watchError}</p>}

      {FIELDS.map((field) => (
        <NumberControl
          key={field.key}
          label={field.label}
          unit={field.unit}
          value={fix[field.key]}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={live && field.key !== 'satellites'}
          onChange={(value) => setFix({ [field.key]: value })}
        />
      ))}
    </div>
  )
}
