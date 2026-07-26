/**
 * Dock body for a `pwm-leds` group.
 *
 * Same cell chrome as {@link GpioLedsBody} (dot + label in a bordered
 * secondary tile). Brightness is the *perceived* lamp under PWM: a short
 * exponential persistence of the channel's square wave (see
 * {@link integrateLedPersistence}), so a ~50 Hz period breathes while
 * kilohertz PWM looks like a steady glow. Labels come from the running
 * build's flattened tree.
 *
 * The strip paints from a continuous requestAnimationFrame loop (DOM styles,
 * not React per frame) so PWM phase is integrated across display frames
 * instead of collapsing to average duty.
 */

import { useEffect, useReducer, useRef } from 'react'
import {
  integrateLedPersistence,
  ledGlowOpacity,
  ledIsLit,
} from '@/lib/ledPersistence'
import {
  formatPwmDuty,
  type PwmChip,
} from '@/virtio/devices/pwm/model'

export interface PwmLedView {
  channel: number
  label: string
}

/** Coalesce chip notifications for collapsed-row badge updates. */
function useChip(chip: PwmChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let frame = 0
    const refresh = () => {
      frame = 0
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(refresh)
    })
    refresh()
    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [chip])
}

/** Cap catch-up after a backgrounded tab so one frame does not integrate seconds. */
const MAX_INTEGRATE_NS = 50_000_000

const DOT_OFF =
  'size-3 rounded-full border border-border bg-transparent'
const DOT_ON =
  'size-3 rounded-full border border-primary bg-primary shadow-[0_0_6px_1px_var(--color-primary)]'

function applyDotStyle(el: HTMLElement, perceived: number) {
  const lit = ledIsLit(perceived)
  if (lit) {
    if (el.className !== DOT_ON) el.className = DOT_ON
    el.style.opacity = String(ledGlowOpacity(perceived))
  } else {
    if (el.className !== DOT_OFF) el.className = DOT_OFF
    el.style.opacity = ''
  }
}

/** LED strip without the frame, shared by the dock row and the window. */
export function PwmLedsBody({
  chip,
  leds,
}: {
  chip: PwmChip
  leds: readonly PwmLedView[]
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const perceivedRef = useRef<Float64Array | null>(null)
  const lastNowNsRef = useRef<number | null>(null)

  useEffect(() => {
    if (leds.length === 0) return

    if (!perceivedRef.current || perceivedRef.current.length !== leds.length) {
      perceivedRef.current = new Float64Array(leds.length)
    }
    lastNowNsRef.current = null

    let raf = 0
    let alive = true

    const tick = (nowMs: number) => {
      if (!alive) return
      const root = rootRef.current
      const perceived = perceivedRef.current
      if (root && perceived) {
        const nowNs = nowMs * 1e6
        const last = lastNowNsRef.current
        const t0Ns =
          last == null ? nowNs : Math.max(last, nowNs - MAX_INTEGRATE_NS)
        lastNowNsRef.current = nowNs

        const cells = root.querySelectorAll<HTMLElement>('[data-pwm-led-cell]')
        for (let i = 0; i < leds.length; i++) {
          const led = leds[i]!
          const ch = chip.getChannel(led.channel)
          const next = integrateLedPersistence(
            perceived[i]!,
            t0Ns,
            nowNs,
            ch.periodNs,
            ch.duty,
            ch.fullOn,
            ch.fullOff,
          )
          perceived[i] = next

          const cell = cells[i]
          if (!cell) continue
          const dot = cell.querySelector<HTMLElement>('[data-pwm-led-dot]')
          if (dot) applyDotStyle(dot, next)
          const duty = Math.max(0, Math.min(1, ch.duty))
          cell.title = `${led.label} (CH${led.channel}) ${formatPwmDuty(duty)}`
        }
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [chip, leds])

  if (leds.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] leading-relaxed text-muted-foreground">
        No <code className="font-mono text-foreground">pwm-leds</code> in this
        build.
      </div>
    )
  }

  return (
    <div ref={rootRef} className="px-3 py-3">
      <div className="grid grid-cols-4 gap-1.5">
        {leds.map((led) => (
          <div
            key={`${led.channel}:${led.label}`}
            data-pwm-led-cell
            className="flex flex-col items-center gap-1 rounded-md border border-border bg-secondary py-1.5 text-[11px] text-muted-foreground"
            title={`${led.label} (CH${led.channel})`}
          >
            <span
              aria-hidden
              data-pwm-led-dot
              className={DOT_OFF}
            />
            <span className="max-w-full truncate px-0.5 text-center leading-tight">
              {led.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Collapsed-row summary: how many channels are programmed above the dark floor. */
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
