/**
 * Dock body for a `pwm-leds` group.
 *
 * Same cell chrome as {@link GpioLedsBody} (dot + label in a bordered
 * secondary tile). Brightness is channel duty from the attached {@link PwmChip}
 * — opacity on the same primary fill/glow the GPIO LEDs use when high.
 * Labels come from the running build's flattened tree.
 */

import { useEffect, useReducer } from 'react'
import { cn } from '@/lib/utils'
import {
  formatPwmDuty,
  type PwmChip,
} from '@/virtio/devices/pwm/model'

const UI_MS = 50

export interface PwmLedView {
  channel: number
  label: string
}

function useChip(chip: PwmChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    refresh()
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

/** LED strip without the frame, shared by the dock row and the window. */
export function PwmLedsBody({
  chip,
  leds,
}: {
  chip: PwmChip
  leds: readonly PwmLedView[]
}) {
  useChip(chip)

  if (leds.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No <code className="font-mono text-foreground">pwm-leds</code> in this
        build.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="space-y-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Outputs — LEDs
        </span>
        <div className="grid grid-cols-4 gap-1.5">
          {leds.map((led) => (
            <PwmLedCell key={`${led.channel}:${led.label}`} chip={chip} led={led} />
          ))}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Zephyr&apos;s stock{' '}
        <code className="font-mono text-foreground">pwm-leds</code> — brightness
        from channel duty on the PWM controller below.
      </p>
    </div>
  )
}

/**
 * GPIO {@link LedPin} layout: bordered secondary tile, size-3 primary dot,
 * label. Duty only scales opacity (and title); no extra metrics row.
 */
function PwmLedCell({ chip, led }: { chip: PwmChip; led: PwmLedView }) {
  const ch = chip.getChannel(led.channel)
  const brightness = Math.max(0, Math.min(1, ch.duty))
  const lit = brightness > 0.02

  return (
    <div
      className="flex flex-col items-center gap-1 rounded-md border border-border bg-secondary py-1.5 text-[11px] text-muted-foreground"
      title={`${led.label} (CH${led.channel}) ${formatPwmDuty(brightness)}`}
    >
      <span
        aria-hidden
        className={cn(
          'size-3 rounded-full border transition-colors',
          lit
            ? 'border-primary bg-primary shadow-[0_0_6px_1px_var(--color-primary)]'
            : 'border-border bg-transparent',
        )}
        style={lit ? { opacity: 0.3 + 0.7 * brightness } : undefined}
      />
      <span className="max-w-full truncate px-0.5 text-center leading-tight">{led.label}</span>
    </div>
  )
}

/** Collapsed-row summary: how many LEDs are visibly lit. */
export function PwmLedsBadge({
  chip,
  leds,
}: {
  chip: PwmChip
  leds: readonly PwmLedView[]
}) {
  useChip(chip)
  const lit = leds.filter((led) => chip.getChannel(led.channel).duty > 0.02).length
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {lit}/{leds.length} on
    </span>
  )
}
