import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react'
import {
  getSnapshot,
  subscribe,
  type StageAction,
  type WatchdogTimer,
} from '@/hostWatchdog'
import { getSnapshot as getPowerSnapshot, subscribe as subscribePower } from '@/hostPowerState'
import { cn } from '@/lib/utils'

/**
 * A watchdog timer group, counting down.
 *
 * The countdown is the guest's, not the wall's: see src/hostWatchdog.ts for
 * why that matters under the interpreter. After a bite the part reboots and
 * the guest starts printing its boot banner again, which from the terminal
 * looks like any other reset; the card keeps the bite and puts the SoC's own
 * reset-reason register next to it, so there is no doubt what happened.
 */

/** How long a fresh bite stays highlighted, in wall-clock milliseconds. */
const BITE_FLASH_MS = 4000

const ACTION_LABEL: Record<StageAction, string> = {
  off: 'off',
  interrupt: 'interrupt',
  'reset-cpu': 'reset CPU',
  'reset-system': 'reset SoC',
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`
}

function isReset(action: StageAction): boolean {
  return action === 'reset-cpu' || action === 'reset-system'
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[11px] text-foreground">{value}</div>
    </div>
  )
}

/** Wall-clock time the page first saw the current bite count, for the flash. */
function useFreshBite(timer: WatchdogTimer | undefined): boolean {
  const count = timer?.lastBite?.count ?? 0
  const seen = useRef(count)
  const [freshUntil, setFreshUntil] = useState(0)
  const [, tick] = useState(0)

  useEffect(() => {
    if (count > seen.current) setFreshUntil(performance.now() + BITE_FLASH_MS)
    seen.current = count
  }, [count])

  const fresh = freshUntil > performance.now()
  useEffect(() => {
    if (!fresh) return
    const id = setTimeout(() => tick((n) => n + 1), freshUntil - performance.now())
    return () => clearTimeout(id)
  }, [fresh, freshUntil])
  return fresh
}

export function WatchdogBody({ timerIndex }: { timerIndex: number }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const power = useSyncExternalStore(subscribePower, getPowerSnapshot, getPowerSnapshot)
  const timer = snap.timers.find((t) => t.index === timerIndex)
  const fresh = useFreshBite(timer)

  if (!timer) {
    return <p className="text-[10px] text-muted-foreground">Waiting for the emulator…</p>
  }

  // A stage whose action is `off` is skipped by the counter, so it is not
  // worth a chip; the last used stage is where the story ends.
  const used = timer.stages
    .map((stage, index) => ({ ...stage, index }))
    .filter((stage) => stage.action !== 'off')
  const current = timer.stages[timer.stage]
  const running = timer.enabled && timer.remainingMs !== null && current !== undefined
  const fraction =
    running && current.timeoutMs > 0
      ? Math.min(1, Math.max(0, timer.remainingMs! / current.timeoutMs))
      : 0
  const danger = running && isReset(current.action)
  const Icon = fresh ? ShieldAlert : timer.enabled ? ShieldCheck : ShieldOff

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            fresh ? 'text-red-400' : danger ? 'text-amber-400' : 'text-muted-foreground',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'text-[11px] font-medium',
            fresh ? 'text-red-300' : 'text-foreground',
          )}
        >
          {fresh ? 'Bit: reset the SoC' : timer.enabled ? 'Running' : 'Disabled'}
        </span>
        {running && (
          <span className="text-[10px] text-muted-foreground">
            stage {timer.stage}, then {ACTION_LABEL[current.action]}
          </span>
        )}
      </div>

      {running && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <span
              className={cn(
                'font-mono text-lg tabular-nums leading-none',
                danger ? 'text-red-300' : 'text-foreground',
              )}
              aria-label="Time until the current stage expires"
            >
              {seconds(timer.remainingMs!)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              of {seconds(current.timeoutMs)}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-100 ease-linear',
                danger ? 'bg-red-500' : fraction < 0.25 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
        </div>
      )}

      {timer.enabled && used.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {used.map((stage) => (
            <span
              key={stage.index}
              className={cn(
                'rounded border px-1 py-px font-mono text-[10px]',
                stage.index === timer.stage
                  ? isReset(stage.action)
                    ? 'border-red-500/60 text-red-300'
                    : 'border-foreground/40 text-foreground'
                  : 'border-border text-muted-foreground',
              )}
            >
              S{stage.index} {seconds(stage.timeoutMs)} → {ACTION_LABEL[stage.action]}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
        <Stat label="Feeds" value={String(timer.feeds)} />
        <Stat label="Interrupts" value={String(timer.interrupts)} />
        <Stat label="Resets" value={String(timer.lastBite?.count ?? 0)} />
      </div>

      {(timer.lastBite || power.available) && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {power.available && <Stat label="Reset reason" value={power.resetReason ?? '—'} />}
          {timer.lastBite && (
            <Stat
              label="Last bite"
              value={`stage ${timer.lastBite.stage}, ${ACTION_LABEL[timer.lastBite.action]}`}
            />
          )}
        </div>
      )}
    </div>
  )
}
