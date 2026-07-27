/**
 * Dock body for gpio-buzzer: latched pin shake + arm host sound/haptics.
 */

import { useSyncExternalStore } from 'react'
import { Vibrate } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  disable as disableBuzzer,
  enable as enableBuzzer,
  getSnapshot,
  subscribe,
} from '@/hostBuzzer'
import {
  getBuzzers,
  subscribe as subscribeGpio,
  type BuzzerPin,
} from '@/hostGpio'

export function BuzzerBody() {
  const buzzers = useSyncExternalStore(subscribeGpio, getBuzzers, () => [])
  if (buzzers.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No <code className="font-mono text-foreground">gpio-buzzer</code> in this
        build&apos;s devicetree.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {buzzers.map((buzzer) => (
        <BuzzerCard key={buzzer.id} buzzer={buzzer} />
      ))}
    </div>
  )
}

function BuzzerCard({ buzzer }: { buzzer: BuzzerPin }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const on = snap.sounding

  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative flex size-12 items-center justify-center rounded-md border border-border bg-background',
            on && 'border-amber-500/50 text-amber-400',
            !on && 'text-muted-foreground',
          )}
          aria-hidden
        >
          {on && (
            <span className="buzzer-pulse pointer-events-none absolute inset-0 rounded-md border border-amber-400/40" />
          )}
          <Vibrate
            className={cn('size-6', on && 'buzzer-shake')}
            strokeWidth={1.75}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{buzzer.label}</div>
          <div className="font-mono text-[10px] text-muted-foreground">
            pin {buzzer.id} · {buzzer.activeHigh ? 'active-high' : 'active-low'}
          </div>
          <div
            className={cn(
              'mt-0.5 text-[11px] font-medium',
              on ? 'text-amber-400' : 'text-muted-foreground',
            )}
          >
            {on ? 'Buzzing' : 'Idle'}
          </div>
        </div>
      </div>

      {!snap.enabled ? (
        <button
          type="button"
          onClick={enableBuzzer}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[11px] text-foreground hover:bg-secondary"
        >
          {snap.preferred
            ? 'Allow host sound / vibration'
            : 'Enable host sound / vibration'}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>
            {!snap.vibrationSupported
              ? 'Host sound on (Vibration API not available here)'
              : snap.vibrationArmed
                ? 'Host sound + vibration on'
                : 'Host sound on (browser blocked vibration)'}
          </span>
          <button
            type="button"
            onClick={disableBuzzer}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            Disable
          </button>
        </div>
      )}
    </div>
  )
}
