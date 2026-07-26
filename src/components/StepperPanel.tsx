/**
 * Dock bodies for steppers: GPIO step/dir (observed edges) and SPI TMC50xx.
 */

import { useEffect, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import { cn } from '@/lib/utils'
import { getSteppers, subscribe as subscribeGpio } from '@/hostGpio'
import { getSnapshot, subscribe } from '@/hostStepper'
import type { Tmc50xxChip } from '@/virtio/devices/chips/tmc50xx'
import { hasRegisterMap } from '@/virtio/devices/registers/types'

/** Visual steps per revolution for the GPIO dial (matches stock sample default). */
const DIAL_STEPS_PER_REV = 200

/** TMC sample: 200 full steps × 256 µsteps per rev. */
const TMC_DIAL_STEPS_PER_REV = 200 * 256

const UI_MS = 50

export function StepperBody() {
  const wiring = useSyncExternalStore(subscribeGpio, getSteppers, () => [])
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (wiring.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No step/dir controller in this build&apos;s tree.
      </div>
    )
  }

  return (
    <div className="space-y-2 px-3 py-3">
      {snap.axes.map((axis) => (
        <AxisRow
          key={axis.id}
          label={axis.label}
          position={axis.position}
          stepsPerRev={DIAL_STEPS_PER_REV}
          stepsPerSec={axis.stepsPerSec}
          moving={axis.moving}
          directionPositive={axis.directionPositive}
          detail={
            <>
              STEP {axis.stepPin}
              <span className={axis.stepActive ? ' text-emerald-400' : ''}>
                {axis.stepActive ? ' ●' : ' ○'}
              </span>
              {' · '}
              DIR {axis.dirPin}
              <span className={axis.dirActive ? ' text-sky-400' : ''}>
                {axis.dirActive ? ' ●' : ' ○'}
              </span>
            </>
          }
        />
      ))}
    </div>
  )
}

/** SPI TMC50xx: shaft dial + optional Registers. */
export function Tmc50xxStepperBody({ chip }: { chip: Tmc50xxChip }) {
  useChipUi(chip)
  const motor = chip.getMotor(0)

  return (
    <div className="px-3 py-3">
      <AxisRow
        label={chip.name}
        position={motor.position}
        stepsPerRev={TMC_DIAL_STEPS_PER_REV}
        stepsPerSec={motor.stepsPerSec}
        moving={motor.moving}
        directionPositive={motor.directionPositive}
        detail={
          <>
            tgt {motor.target}
            {motor.enabled ? '' : ' · off'}
          </>
        }
        trailing={hasRegisterMap(chip) ? <RegisterMapButton chip={chip} /> : null}
      />
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

function AxisRow({
  label,
  position,
  stepsPerRev,
  stepsPerSec,
  moving,
  directionPositive,
  detail,
  trailing,
}: {
  label: string
  position: number
  stepsPerRev: number
  stepsPerSec: number
  moving: boolean
  directionPositive: boolean
  detail: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <ShaftDial position={position} stepsPerRev={stepsPerRev} moving={moving} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs font-medium text-foreground">{label}</div>
          {trailing}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{detail}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] tabular-nums">
          <span>
            <span className="text-muted-foreground">pos </span>
            <span className="text-foreground">{position}</span>
          </span>
          <span className={cn(moving ? 'text-emerald-400' : 'text-muted-foreground')}>
            {formatRate(stepsPerSec)}
          </span>
          <span className="w-8 text-muted-foreground">
            {moving ? (directionPositive ? 'CW' : 'CCW') : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Continuous shaft angle — accumulate position deltas so a rev wrap never
 * spins the needle the long way (CSS transitions made that jump).
 */
function ShaftDial({
  position,
  stepsPerRev,
  moving,
}: {
  position: number
  stepsPerRev: number
  moving: boolean
}) {
  const angleRef = useRef({ pos: position, deg: 0 })
  if (angleRef.current.pos !== position) {
    const delta = position - angleRef.current.pos
    angleRef.current.pos = position
    angleRef.current.deg += (delta / stepsPerRev) * 360
  }
  const angle = angleRef.current.deg

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
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '24px 24px' }}>
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
    </div>
  )
}

function formatRate(stepsPerSec: number): string {
  if (stepsPerSec < 0.05) return '0/s'
  if (stepsPerSec < 10) return `${stepsPerSec.toFixed(1)}/s`
  return `${Math.round(stepsPerSec)}/s`
}
