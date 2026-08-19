import { useSyncExternalStore } from 'react'
import { BatteryLow, Moon, Sun } from 'lucide-react'
import { getSnapshot, subscribe, type PowerSnapshot } from '@/hostPowerState'
import { cn } from '@/lib/utils'

/**
 * The SoC's RTC controller, which is where sleep lives.
 *
 * Everything else in the dock shows something the guest is doing. This shows
 * something it has stopped doing, which is the only way to tell a sleeping
 * board from a wedged one: light sleep looks exactly like a hang from the
 * terminal, because the guest simply stops printing.
 */

/** µs at a scale a human reads: 950 µs, 54 ms, 2.1 s. */
function duration(us: number): string {
  if (us === 0) return '0'
  if (us < 1000) return `${us} µs`
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`
  return `${(us / 1_000_000).toFixed(1)} s`
}

const STATE_LABEL: Record<PowerSnapshot['state'], string> = {
  awake: 'Awake',
  'light-sleep': 'Light sleep',
  'deep-sleep': 'Deep sleep',
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[11px] text-foreground">{value}</div>
    </div>
  )
}

export function PowerBody() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const asleep = snap.state !== 'awake'
  const Icon = snap.state === 'awake' ? Sun : snap.state === 'light-sleep' ? Moon : BatteryLow

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            asleep ? 'text-violet-400' : 'text-muted-foreground',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'text-[11px] font-medium',
            asleep ? 'text-violet-300' : 'text-foreground',
          )}
        >
          {STATE_LABEL[snap.state]}
        </span>
        {asleep && (
          <span className="text-[10px] text-muted-foreground">
            for {duration(snap.lastSleepUs)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <Stat label="Reset reason" value={snap.resetReason ?? '—'} />
        <Stat label="Sleeps" value={String(snap.sleepCount)} />
        <Stat label="Time asleep" value={duration(snap.totalSleepUs)} />
        <Stat label="RTC counter" value={snap.rtcTicks.toLocaleString()} />
      </div>

      {snap.rejectCount > 0 && (
        <p className="text-[10px] text-amber-400">
          {snap.rejectCount} sleep{snap.rejectCount === 1 ? '' : 's'} rejected: nothing was
          armed to end {snap.rejectCount === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  )
}
