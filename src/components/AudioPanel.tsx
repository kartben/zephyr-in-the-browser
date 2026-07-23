import { useState, useSyncExternalStore } from 'react'
import { ChevronDown, Volume2, VolumeX, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getSnapshot, subscribe, toggle } from '@/hostAudio'

/**
 * Floating control for the qemu,host-audio bridge.
 *
 * Hidden entirely when the running emulator has no audio device, so a stock
 * qemu-wasm build shows no dead UI. Sound starts muted — the Web Audio API is
 * gated behind a user gesture by the browser autoplay policy, so the enable
 * button is not just politeness — and the guest's samples are drained (and
 * dropped) even while muted, so guest-side flow control never notices the
 * difference. Reach it from the shell with `hostaudio beep` or
 * `hostaudio melody`.
 */
export function AudioPanel() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (!snap.available || dismissed) return null

  return (
    <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2',
          !collapsed && 'border-b border-border',
        )}
      >
        <Volume2 className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium">Host Audio</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={collapsed ? 'Expand host audio' : 'Collapse host audio'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide audio panel"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && (
        <div className="space-y-3 px-3 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant={snap.enabled ? 'secondary' : 'default'}
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              aria-pressed={snap.enabled}
              onClick={toggle}
            >
              {snap.enabled ? (
                <VolumeX className="size-3.5" aria-hidden />
              ) : (
                <Volume2 className="size-3.5" aria-hidden />
              )}
              {snap.enabled ? 'Mute' : 'Enable sound'}
            </Button>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {snap.rate > 0 ? `${(snap.rate / 1000).toFixed(0)} kHz mono s16` : ''}
            </span>
          </div>

          <div
            role="meter"
            aria-label="Output level"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={snap.level}
            className="h-1.5 overflow-hidden rounded-full bg-secondary"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-100"
              style={{ width: `${Math.round(snap.level * 100)}%` }}
            />
          </div>

          <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
            In the guest:{' '}
            <code className="font-mono text-foreground">hostaudio beep 440 500</code>{' '}
            queues a tone,{' '}
            <code className="font-mono text-foreground">hostaudio melody</code> a short
            tune.
          </p>
        </div>
      )}
    </div>
  )
}
