/**
 * Dock bodies for steppers: GPIO step/dir (observed edges) and SPI TMC50xx
 * (register-driven motion sim).
 */

import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { RotateCw } from 'lucide-react'
import { RegisterMapButton } from '@/components/RegisterMap'
import { cn } from '@/lib/utils'
import { getSteppers, subscribe as subscribeGpio } from '@/hostGpio'
import {
  getSnapshot,
  subscribe,
  type StepperAxisSnapshot,
} from '@/hostStepper'
import type { Tmc50xxChip, Tmc50xxMotorSnapshot } from '@/virtio/devices/chips/tmc50xx'
import { hasRegisterMap } from '@/virtio/devices/registers/types'

/** Visual steps per revolution for the GPIO dial (matches stock sample default). */
const DIAL_STEPS_PER_REV = 200

/** TMC sample uses 200 full steps × 256 µsteps — dial one rev on that. */
const TMC_DIAL_STEPS_PER_REV = 200 * 256

const UI_MS = 50

export function StepperBody() {
  const wiring = useSyncExternalStore(subscribeGpio, getSteppers, () => [])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (wiring.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No{' '}
        <code className="font-mono text-foreground">zephyr,gpio-step-dir-stepper-ctrl</code>{' '}
        in this build&apos;s devicetree.
      </div>
    )
  }

  return (
    <div className="space-y-3 px-3 py-3">
      {snap.axes.map((axis) => (
        <StepperCard key={axis.id} axis={axis} />
      ))}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Stock Zephyr{' '}
        <code className="font-mono text-foreground">zephyr,gpio-step-dir-stepper-ctrl</code>{' '}
        — STEP/DIR on GPIO. Press SW0 in Keys to advance the generic sample
        modes. Try{' '}
        <code className="font-mono text-foreground">samples/drivers/stepper/generic</code>.
      </p>
    </div>
  )
}

/** SPI TMC50xx: shaft dial + register map for motor 0. */
export function Tmc50xxStepperBody({ chip }: { chip: Tmc50xxChip }) {
  useChipUi(chip)
  const motor = chip.getMotor(0)

  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          Motor 0 · {motor.enabled ? 'enabled' : 'disabled'}
          {motor.moving ? ' · moving' : ' · idle'}
        </div>
        {hasRegisterMap(chip) ? <RegisterMapButton chip={chip} /> : null}
      </div>
      <TmcMotorCard motor={motor} label={chip.name} />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Stock Zephyr{' '}
        <code className="font-mono text-foreground">adi,tmc50xx</code> over SPI —
        positioning mode writes <code className="font-mono text-foreground">XTARGET</code>,
        the page advances <code className="font-mono text-foreground">XACTUAL</code> and
        sets <code className="font-mono text-foreground">RAMPSTAT</code> POS_REACHED.
        Try{' '}
        <code className="font-mono text-foreground">samples/drivers/stepper/tmc50xx</code>.
      </p>
    </div>
  )
}

function useChipUi(chip: { subscribe: (fn: () => void) => () => void; version: () => number }) {
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

function StepperCard({ axis }: { axis: StepperAxisSnapshot }) {
  const angle = ((axis.position % DIAL_STEPS_PER_REV) / DIAL_STEPS_PER_REV) * 360
  const rate = axis.stepsPerSec

  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-3">
        <ShaftDial
          angle={angle}
          moving={axis.moving}
          directionPositive={axis.directionPositive}
        />
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
          <MotionReadout
            position={axis.position}
            rate={rate}
            moving={axis.moving}
            directionPositive={axis.directionPositive}
          />
        </div>
      </div>
    </div>
  )
}

function TmcMotorCard({ motor, label }: { motor: Tmc50xxMotorSnapshot; label: string }) {
  const wrapped =
    ((motor.position % TMC_DIAL_STEPS_PER_REV) + TMC_DIAL_STEPS_PER_REV) % TMC_DIAL_STEPS_PER_REV
  const angle = (wrapped / TMC_DIAL_STEPS_PER_REV) * 360

  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-3">
        <ShaftDial
          angle={angle}
          moving={motor.moving}
          directionPositive={motor.directionPositive}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <RotateCw
              className={cn(
                'size-3.5 shrink-0',
                motor.moving ? 'text-emerald-400' : 'text-muted-foreground',
                motor.moving && !motor.directionPositive && 'scale-x-[-1]',
              )}
              strokeWidth={1.75}
            />
            <div className="truncate text-xs font-medium text-foreground">{label}</div>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            target {motor.target}
            {' · '}
            mode {motor.rampMode}
          </div>
          <MotionReadout
            position={motor.position}
            rate={motor.stepsPerSec}
            moving={motor.moving}
            directionPositive={motor.directionPositive}
          />
        </div>
      </div>
    </div>
  )
}

function ShaftDial({
  angle,
  moving,
  directionPositive,
}: {
  angle: number
  moving: boolean
  directionPositive: boolean
}) {
  void directionPositive
  return (
    <div
      className={cn(
        'relative flex size-14 shrink-0 items-center justify-center rounded-md border border-border bg-background',
        moving && 'border-emerald-500/45',
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
            className={moving ? 'text-emerald-400' : 'text-foreground'}
          />
          <circle
            cx="24"
            cy="24"
            r="2.5"
            className={moving ? 'fill-emerald-400' : 'fill-foreground'}
          />
        </g>
      </svg>
      {moving && (
        <span className="stepper-pulse pointer-events-none absolute inset-0 rounded-md border border-emerald-400/35" />
      )}
    </div>
  )
}

function MotionReadout({
  position,
  rate,
  moving,
  directionPositive,
}: {
  position: number
  rate: number
  moving: boolean
  directionPositive: boolean
}) {
  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[11px]">
      <span>
        <span className="text-muted-foreground">pos </span>
        <span className="text-foreground">{position}</span>
      </span>
      <span>
        <span className="text-muted-foreground">vel </span>
        <span className={moving ? 'text-emerald-400' : 'text-muted-foreground'}>
          {formatRate(rate)}
        </span>
      </span>
      <span className="text-muted-foreground">
        {moving ? (directionPositive ? 'CW' : 'CCW') : 'idle'}
      </span>
    </div>
  )
}

function formatRate(stepsPerSec: number): string {
  if (stepsPerSec < 0.05) return '0 steps/s'
  if (stepsPerSec < 10) return `${stepsPerSec.toFixed(1)} steps/s`
  return `${Math.round(stepsPerSec)} steps/s`
}
