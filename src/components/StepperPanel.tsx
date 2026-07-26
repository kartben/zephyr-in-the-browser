/**
 * Dock body for steppers: GPIO step/dir observation or TMCM-3216 over UART.
 */

import { useSyncExternalStore } from 'react'
import { RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getSteppers, subscribe as subscribeGpio } from '@/hostGpio'
import {
  getSnapshot as getGpioStepperSnapshot,
  subscribe as subscribeGpioStepper,
  type StepperAxisSnapshot,
} from '@/hostStepper'
import * as hostTmcm3216 from '@/hostTmcm3216'

/** Visual steps per revolution for the dial (matches stock sample default). */
const DIAL_STEPS_PER_REV = 200

function subscribeSteppers(fn: () => void): () => void {
  const a = subscribeGpioStepper(fn)
  const b = hostTmcm3216.subscribe(fn)
  return () => {
    a()
    b()
  }
}

function getCombinedSnapshot(): { axes: StepperAxisSnapshot[]; source: 'tmcm' | 'gpio' | 'none' } {
  if (hostTmcm3216.isActive()) {
    return { axes: hostTmcm3216.getSnapshot().axes, source: 'tmcm' }
  }
  const gpio = getGpioStepperSnapshot()
  if (gpio.axes.length > 0) return { axes: gpio.axes, source: 'gpio' }
  return { axes: [], source: 'none' }
}

export function StepperBody() {
  const wiring = useSyncExternalStore(subscribeGpio, getSteppers, () => [])
  const snap = useSyncExternalStore(subscribeSteppers, getCombinedSnapshot, getCombinedSnapshot)

  if (snap.axes.length === 0 && wiring.length === 0 && !hostTmcm3216.isActive()) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No stepper in this build&apos;s devicetree (
        <code className="font-mono text-foreground">zephyr,gpio-step-dir-stepper-ctrl</code> or{' '}
        <code className="font-mono text-foreground">adi,tmcm3216</code>).
      </div>
    )
  }

  const footnote =
    snap.source === 'tmcm' ? (
      <>
        ADI <code className="font-mono text-foreground">TMCM-3216</code> over uart1 RS485/TMCL —
        stock <code className="font-mono text-foreground">samples/drivers/stepper/tmcm3216</code>{' '}
        ping-pongs; the dial tracks simulated axis motion.
      </>
    ) : (
      <>
        Stock Zephyr{' '}
        <code className="font-mono text-foreground">zephyr,gpio-step-dir-stepper-ctrl</code> —
        STEP/DIR on GPIO. Press SW0 in Keys to advance the generic sample modes. Try{' '}
        <code className="font-mono text-foreground">samples/drivers/stepper/generic</code>.
      </>
    )

  return (
    <div className="space-y-3 px-3 py-3">
      {snap.axes.map((axis) => (
        <StepperCard key={axis.id} axis={axis} showPins={snap.source === 'gpio'} />
      ))}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{footnote}</p>
    </div>
  )
}

function StepperCard({
  axis,
  showPins,
}: {
  axis: StepperAxisSnapshot
  showPins: boolean
}) {
  const angle = ((axis.position % DIAL_STEPS_PER_REV) / DIAL_STEPS_PER_REV) * 360
  const rate = axis.stepsPerSec

  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'relative flex size-14 shrink-0 items-center justify-center rounded-md border border-border bg-background',
            axis.moving && 'border-emerald-500/45',
          )}
          aria-hidden
        >
          <svg viewBox="0 0 48 48" className="size-11 text-muted-foreground">
            <circle
              cx="24"
              cy="24"
              r="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              className="opacity-40"
            />
            <g
              className="origin-center transition-transform duration-75 ease-linear"
              style={{ transform: `rotate(${angle}deg)` }}
            >
              <line
                x1="24"
                y1="24"
                x2="24"
                y2="8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className={axis.moving ? 'text-emerald-400' : 'text-foreground'}
              />
              <circle
                cx="24"
                cy="24"
                r="2.5"
                className={axis.moving ? 'fill-emerald-400' : 'fill-foreground'}
              />
            </g>
          </svg>
          {axis.moving && (
            <span className="stepper-pulse pointer-events-none absolute inset-0 rounded-md border border-emerald-400/35" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <RotateCw
              className={cn(
                'size-3.5 shrink-0',
                axis.moving ? 'text-emerald-400' : 'text-muted-foreground',
                axis.moving && !axis.directionPositive && 'scale-x-[-1]',
              )}
              strokeWidth={1.75}
            />
            <div className="truncate text-xs font-medium text-foreground">{axis.label}</div>
          </div>
          {showPins ? (
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              STEP {axis.stepPin}
              <span className={axis.stepActive ? ' text-emerald-400' : ''}>
                {axis.stepActive ? ' ●' : ' ○'}
              </span>
              {' · '}
              DIR {axis.dirPin}
              <span className={axis.dirActive ? ' text-sky-400' : ''}>
                {axis.dirActive ? ' ●' : ' ○'}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">TMCL axis</div>
          )}
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <span>
              <span className="text-muted-foreground">pos </span>
              <span className="text-foreground">{axis.position}</span>
            </span>
            <span>
              <span className="text-muted-foreground">vel </span>
              <span className={axis.moving ? 'text-emerald-400' : 'text-muted-foreground'}>
                {formatRate(rate)}
              </span>
            </span>
            <span className="text-muted-foreground">
              {axis.moving ? (axis.directionPositive ? 'CW' : 'CCW') : 'idle'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatRate(stepsPerSec: number): string {
  if (stepsPerSec < 0.05) return '0 steps/s'
  if (stepsPerSec < 10) return `${stepsPerSec.toFixed(1)} steps/s`
  return `${Math.round(stepsPerSec)} steps/s`
}
