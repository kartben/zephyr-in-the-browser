import { useEffect, useState, useSyncExternalStore } from 'react'
import { ChevronDown, MapPin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  available,
  getSnapshot,
  setFix,
  subscribe,
  watchBrowserPosition,
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

/** Controls the NMEA fixes streamed into the guest's second UART. */
export function GnssPanel() {
  const isAvailable = useSyncExternalStore(subscribe, available, () => false)
  const fix = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [live, setLive] = useState(false)
  const [locationError, setLocationError] = useState('')

  useEffect(() => {
    if (!live) return
    return watchBrowserPosition(setLocationError)
  }, [live])

  if (!isAvailable || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <MapPin className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">GNSS</span>
        <span className="font-mono text-[11px] text-muted-foreground">NMEA UART</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand GNSS' : 'Collapse GNSS'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide GNSS panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-[min(28rem,60vh)] space-y-3 overflow-y-auto px-3 py-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={live}
              onChange={(event) => setLive(event.target.checked)}
              className="accent-[var(--color-primary)]"
            />
            Follow browser location
          </label>

          {locationError && <p className="text-[11px] text-destructive">{locationError}</p>}

          <div className="grid grid-cols-2 gap-2">
            {FIELDS.map((field) => (
              <label key={field.key} className="space-y-1 text-[11px] text-muted-foreground">
                <span>{field.label}</span>
                <span className="flex items-center rounded-md border border-input bg-background px-2">
                  <input
                    type="number"
                    aria-label={field.label}
                    value={fix[field.key]}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    disabled={live && field.key !== 'satellites'}
                    onChange={(event) => setFix({ [field.key]: Number(event.target.value) })}
                    className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-xs text-foreground outline-none disabled:opacity-50"
                  />
                  {field.unit && <span className="ml-1">{field.unit}</span>}
                </span>
              </label>
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            GGA and RMC fixes are sent once per second to Zephyr’s generic NMEA GNSS driver.
          </p>
        </div>
      )}
    </div>
  )
}
