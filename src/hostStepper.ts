/**
 * Observe `zephyr,gpio-step-dir-stepper-ctrl` STEP/DIR GPIO activity.
 * Lives outside the dock panel so collapsed rows still track position.
 *
 * Mirrors the Zephyr gpio_step_dir driver without dual-edge: one step is
 * counted on the STEP pin's inactive edge (falling when active-high).
 * Direction comes from the DIR pin at that instant (high = positive unless
 * `invert-direction`).
 */

import {
  getSteppers,
  isOutputHigh,
  subscribeOutputs,
  type StepperAxis,
} from '@/hostGpio'

/** Window used for steps/s (EMA-friendly ring of edge timestamps). */
const VELOCITY_WINDOW_MS = 250

/** Below this rate the shaft is treated as idle for the badge. */
export const IDLE_STEPS_PER_SEC = 0.5

export interface StepperAxisSnapshot {
  id: string
  label: string
  stepPin: number
  dirPin: number
  /** Guest position estimate from observed STEP edges. */
  position: number
  /** Positive = CW / forward on the dial. */
  directionPositive: boolean
  /** Absolute steps/s over the recent window. */
  stepsPerSec: number
  stepActive: boolean
  dirActive: boolean
  moving: boolean
}

export interface StepperSnapshot {
  axes: StepperAxisSnapshot[]
}

interface AxisRuntime {
  axis: StepperAxis
  position: number
  /** Last observed physical STEP level. */
  stepHigh: boolean
  /** Recent step edge timestamps (ms). */
  edges: number[]
}

const listeners = new Set<() => void>()

let runtimes: AxisRuntime[] = []
let gpioUnsub: (() => void) | undefined
let snapshotCache: StepperSnapshot = { axes: [] }

function pinActive(high: boolean, activeHigh: boolean): boolean {
  return activeHigh ? high : !high
}

function directionPositive(axis: StepperAxis, dirHigh: boolean): boolean {
  const dirActive = pinActive(dirHigh, axis.dirActiveHigh)
  return axis.invertDirection ? !dirActive : dirActive
}

function pruneEdges(edges: number[], now: number) {
  const cutoff = now - VELOCITY_WINDOW_MS
  while (edges.length > 0 && edges[0]! < cutoff) edges.shift()
}

function stepsPerSec(edges: number[], now: number): number {
  pruneEdges(edges, now)
  if (edges.length < 2) return edges.length === 1 ? 1 / (VELOCITY_WINDOW_MS / 1000) : 0
  const span = (edges[edges.length - 1]! - edges[0]!) / 1000
  if (span <= 0) return 0
  return (edges.length - 1) / span
}

function syncWiring() {
  const declared = getSteppers()
  const byId = new Map(runtimes.map((r) => [r.axis.id, r]))
  const next: AxisRuntime[] = []
  for (const axis of declared) {
    const prev = byId.get(axis.id)
    if (prev) {
      prev.axis = axis
      next.push(prev)
    } else {
      next.push({
        axis,
        position: 0,
        stepHigh: isOutputHigh(axis.stepPin),
        edges: [],
      })
    }
  }
  runtimes = next
}

function buildSnapshot(): StepperSnapshot {
  const now = performance.now()
  return {
    axes: runtimes.map((rt) => {
      const stepHigh = isOutputHigh(rt.axis.stepPin)
      const dirHigh = isOutputHigh(rt.axis.dirPin)
      const rate = stepsPerSec(rt.edges, now)
      const positive = directionPositive(rt.axis, dirHigh)
      return {
        id: rt.axis.id,
        label: rt.axis.label,
        stepPin: rt.axis.stepPin,
        dirPin: rt.axis.dirPin,
        position: rt.position,
        directionPositive: positive,
        stepsPerSec: rate,
        stepActive: pinActive(stepHigh, rt.axis.stepActiveHigh),
        dirActive: pinActive(dirHigh, rt.axis.dirActiveHigh),
        moving: rate >= IDLE_STEPS_PER_SEC,
      }
    }),
  }
}

function snapshotsEqual(a: StepperSnapshot, b: StepperSnapshot): boolean {
  if (a.axes.length !== b.axes.length) return false
  for (let i = 0; i < a.axes.length; i++) {
    const x = a.axes[i]!
    const y = b.axes[i]!
    if (
      x.id !== y.id ||
      x.label !== y.label ||
      x.stepPin !== y.stepPin ||
      x.dirPin !== y.dirPin ||
      x.position !== y.position ||
      x.directionPositive !== y.directionPositive ||
      x.stepActive !== y.stepActive ||
      x.dirActive !== y.dirActive ||
      x.moving !== y.moving ||
      Math.abs(x.stepsPerSec - y.stepsPerSec) > 0.05
    ) {
      return false
    }
  }
  return true
}

function refreshSnapshot(): boolean {
  const next = buildSnapshot()
  if (snapshotsEqual(snapshotCache, next)) return false
  snapshotCache = next
  return true
}

function notify() {
  if (!refreshSnapshot()) return
  for (const fn of listeners) fn()
}

function onGpioChange() {
  syncWiring()
  const now = performance.now()
  for (const rt of runtimes) {
    const stepHigh = isOutputHigh(rt.axis.stepPin)
    if (stepHigh === rt.stepHigh) continue
    const wasActive = pinActive(rt.stepHigh, rt.axis.stepActiveHigh)
    const nowActive = pinActive(stepHigh, rt.axis.stepActiveHigh)
    rt.stepHigh = stepHigh
    // Non-dual-edge: count the inactive edge (high→low for active-high STEP).
    if (wasActive && !nowActive) {
      const positive = directionPositive(rt.axis, isOutputHigh(rt.axis.dirPin))
      rt.position += positive ? 1 : -1
      rt.edges.push(now)
      pruneEdges(rt.edges, now)
    }
  }
  notify()
}

function ensureWatching() {
  if (gpioUnsub) return
  syncWiring()
  gpioUnsub = subscribeOutputs(onGpioChange)
  onGpioChange()
}

export function getSnapshot(): StepperSnapshot {
  ensureWatching()
  return snapshotCache
}

export function subscribe(fn: () => void): () => void {
  ensureWatching()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test helper: drop GPIO watch and axis state. */
export function resetForTests() {
  gpioUnsub?.()
  gpioUnsub = undefined
  runtimes = []
  listeners.clear()
  snapshotCache = { axes: [] }
}
