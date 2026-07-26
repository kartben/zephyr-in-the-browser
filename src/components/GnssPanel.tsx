/** Dock body for editing the simulated GNSS fix. */

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

/** The fix editor for the NMEA stream, shared by the dock row and the window. */
export function GnssBody() {
  const fix = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // Lives in hostGnss so the geolocation watch survives this body unmounting.
  const live = useSyncExternalStore(subscribe, followingBrowser, () => false)
  const watchError = useSyncExternalStore(subscribe, locationError, () => '')

  return (
    <div className="space-y-1 px-3 py-2.5">
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

      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        GGA and RMC fixes are sent once per second to Zephyr’s generic NMEA GNSS driver.
      </p>
    </div>
  )
}
