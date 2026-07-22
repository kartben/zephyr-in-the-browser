import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Activity, ChevronDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CHANNELS, available, get, set, startBattery, startOrientation, subscribe } from '@/hostSensor'

/**
 * Floating control for the qemu,host-sensor bridge.
 *
 * Hidden entirely when the running emulator has no sensor device, so a stock
 * qemu-wasm build shows no dead UI. Values written here land in the guest's
 * MMIO window, where the Zephyr driver reads them — try `sensor get
 * host_sensor` in the shell.
 */
export function SensorPanel() {
  const isAvailable = useSyncExternalStore(subscribe, available, () => false)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [live, setLive] = useState(false)

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

  if (!isAvailable || dismissed) return null

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20 w-[19rem] max-w-[calc(100%-2rem)]">
      <div className="pointer-events-auto overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Activity className="size-3.5 text-primary" aria-hidden />
          <span className="text-xs font-medium">Host sensors</span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={collapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
            >
              <ChevronDown className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Hide sensor panel"
              onClick={() => setDismissed(true)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>

        {!collapsed && (
          // Eight channels overflow a short viewport, so the body scrolls
          // rather than pushing the header off screen.
          <div className="max-h-[min(26rem,60vh)] space-y-2.5 overflow-y-auto px-3 py-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Follow device sensors where available
            </label>

            {CHANNELS.map((c) => (
              <ChannelRow key={c.id} channel={c} disabled={live} />
            ))}

            <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
              Read them in the guest with{' '}
              <code className="font-mono text-foreground">sensor get host_sensor</code>.
            </p>
          </div>
        )}
      </div>
    </div>
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
