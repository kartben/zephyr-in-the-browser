import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Activity } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import {
  CHANNELS,
  available,
  get,
  orientationNeedsPermission,
  requestOrientationPermission,
  set,
  startBattery,
  startOrientation,
  subscribe,
} from '@/hostSensor'

/**
 * Floating control for the qemu,host-sensor bridge.
 *
 * Hidden entirely when the running emulator has no sensor device, so a stock
 * qemu-wasm build shows no dead UI. Values written here land in the guest's
 * MMIO window, where the Zephyr driver reads them — try `sensor get
 * host_sensor` in the shell.
 */
export function SensorPanel({ defaultExpanded = true }: { defaultExpanded?: boolean }) {
  const isAvailable = useSyncExternalStore(subscribe, available, () => false)
  const [live, setLive] = useState(false)
  const [motionError, setMotionError] = useState<string | null>(null)

  // Seed each channel once so the guest reads something sensible before the
  // user touches anything.
  useEffect(() => {
    if (!isAvailable) return
    const seed: Record<number, number> = { 0: 0, 1: 0, 2: 9.81, 3: 21, 4: 300, 5: 45, 6: 101.3, 7: 100 }
    for (const [ch, v] of Object.entries(seed)) {
      if (get(Number(ch)) === undefined) set(Number(ch), v)
    }
  }, [isAvailable])

  useEffect(() => {
    if (!live) return
    let stopBattery: (() => void) | undefined
    const stopOrientation = startOrientation()
    void startBattery().then((stop) => (stopBattery = stop))
    return () => {
      stopOrientation()
      stopBattery?.()
    }
  }, [live])

  // On iOS Safari the permission prompt must be requested synchronously from
  // this same click, so it happens here rather than in the useEffect above —
  // by the time an effect runs, the gesture that would authorize it is gone.
  const onToggleLive = (checked: boolean) => {
    if (!checked || !orientationNeedsPermission()) {
      setMotionError(null)
      setLive(checked)
      return
    }
    void requestOrientationPermission().then((result) => {
      if (result === 'granted') {
        setMotionError(null)
        setLive(true)
      } else {
        setMotionError('Motion access was denied. Enable it in Settings > Safari > Motion & Orientation Access.')
        setLive(false)
      }
    })
  }

  if (!isAvailable) return null

  return (
    <PanelFrame id="sensor" title="Host sensors" icon={Activity} defaultExpanded={defaultExpanded}>
      {/* Eight channels overflow a short viewport, so the body scrolls rather
          than pushing the header off screen. */}
      <div className="max-h-[min(26rem,60vh)] space-y-2.5 overflow-y-auto px-3 py-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => onToggleLive(e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          Follow device sensors where available
        </label>

        {motionError && <p className="text-[11px] leading-relaxed text-destructive">{motionError}</p>}

        {CHANNELS.map((c) => (
          <ChannelRow key={c.id} channel={c} disabled={live} />
        ))}

        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          Read them in the guest with{' '}
          <code className="font-mono text-foreground">sensor get host_sensor</code>.
        </p>
      </div>
    </PanelFrame>
  )
}

function ChannelRow({
  channel,
  disabled,
}: {
  channel: (typeof CHANNELS)[number]
  disabled: boolean
}) {
  const value = useSyncExternalStore(
    subscribe,
    useCallback(() => get(channel.id), [channel.id]),
    () => undefined,
  )

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs">{channel.label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {value === undefined ? '—' : value.toFixed(2)} {channel.unit}
        </span>
      </div>
      <input
        type="range"
        min={channel.min}
        max={channel.max}
        step={(channel.max - channel.min) / 200}
        value={value ?? channel.min}
        disabled={disabled}
        aria-label={channel.label}
        onChange={(e) => set(channel.id, Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  )
}
