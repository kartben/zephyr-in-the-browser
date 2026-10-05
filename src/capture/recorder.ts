/**
 * Motion readings for the capture page, normalized to the guest's frame.
 *
 * The page feeds the ADXL345 from `accelerationIncludingGravity` through
 * liveSource.ts, so the capture reads the same event and applies the same two
 * corrections: Safari's opposite sign convention, and old iOS builds that
 * report g instead of m/s². One difference: liveSource decides the unit per
 * reading (a magnitude between 0.1 and 2.5 is taken for g), and a fast
 * downward stroke can dip into that band in m/s², so a capture decides once,
 * from readings taken while the phone is held still.
 */

import { motionGravityIsInverted } from '@/virtio/devices/sensors/liveSource'
import { roundRow, type Hold, type MotionRow, type RotationRow, type Take, type TakeLabel } from './session'

const G = 9.80665

/** Readings used to decide the unit before any take is recorded. */
export const SETTLE_READINGS = 30

export interface Normalization {
  inverted: boolean
  scaledFromG: boolean
}

export interface RawReading {
  /** Event time, ms on the performance.now() clock. */
  t: number
  x: number
  y: number
  z: number
  /** alpha, beta, gamma in deg/s, when the browser reports a rotation rate. */
  rotation: [number, number, number] | null
}

export function decideNormalization(magnitudes: readonly number[], inverted: boolean): Normalization {
  const sorted = [...magnitudes].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1] ?? G
  return { inverted, scaledFromG: median > 0.1 && median < 2.5 }
}

export function normalizeMotion(
  x: number,
  y: number,
  z: number,
  n: Normalization,
): [number, number, number] {
  const scale = (n.scaledFromG ? G : 1) * (n.inverted ? -1 : 1)
  return [x * scale, y * scale, z * scale]
}

/** Median of the gaps between successive times, or null with too few. */
export function medianInterval(times: readonly number[]): number | null {
  if (times.length < 3) return null
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!)
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1]!
}

export function readingFromEvent(e: DeviceMotionEvent, now: () => number = () => performance.now()): RawReading | null {
  const a = e.accelerationIncludingGravity
  if (!a || a.x == null || a.y == null || a.z == null) return null
  if (![a.x, a.y, a.z].every(Number.isFinite)) return null
  const r = e.rotationRate
  const rotation =
    r && r.alpha != null && r.beta != null && r.gamma != null && [r.alpha, r.beta, r.gamma].every(Number.isFinite)
      ? ([r.alpha, r.beta, r.gamma] as [number, number, number])
      : null
  return { t: e.timeStamp > 0 ? e.timeStamp : now(), x: a.x, y: a.y, z: a.z, rotation }
}

interface OpenTake {
  label: TakeLabel
  hold: Hold
  startedAt: string
  t0: number
  cueMs: number | null
  samples: MotionRow[]
  rotation: RotationRow[]
}

/**
 * Listens to `devicemotion` for the life of the page: keeps the latest reading
 * for the live view, measures the event rate, and records into the open take.
 */
export class MotionCapture {
  normalization: Normalization | null = null
  latest: [number, number, number] | null = null
  private readonly inverted: boolean
  private readonly settle: number[] = []
  private readonly recent: number[] = []
  private take: OpenTake | null = null
  private readonly listeners = new Set<() => void>()
  private stopListening: (() => void) | null = null

  constructor(
    private readonly target: EventTarget = window,
    inverted: boolean = motionGravityIsInverted(),
  ) {
    this.inverted = inverted
  }

  start(): void {
    if (this.stopListening) return
    const handler = (e: Event) => {
      const reading = readingFromEvent(e as DeviceMotionEvent)
      if (reading) this.push(reading)
    }
    this.target.addEventListener('devicemotion', handler)
    this.stopListening = () => this.target.removeEventListener('devicemotion', handler)
  }

  stop(): void {
    this.stopListening?.()
    this.stopListening = null
  }

  /** Called after each reading; the live view re-renders from it. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Median event interval over the last second or so, ms. */
  intervalMs(): number | null {
    return medianInterval(this.recent)
  }

  get ready(): boolean {
    return this.normalization !== null
  }

  push(reading: RawReading): void {
    this.recent.push(reading.t)
    if (this.recent.length > 64) this.recent.shift()
    if (!this.normalization) {
      this.settle.push(Math.hypot(reading.x, reading.y, reading.z))
      if (this.settle.length >= SETTLE_READINGS) {
        this.normalization = decideNormalization(this.settle, this.inverted)
      }
    }
    const n = this.normalization ?? { inverted: this.inverted, scaledFromG: false }
    this.latest = normalizeMotion(reading.x, reading.y, reading.z, n)
    const take = this.take
    if (take && this.normalization) {
      const t = reading.t - take.t0
      if (t >= 0) {
        take.samples.push(roundRow([t, ...this.latest] as MotionRow))
        if (reading.rotation) take.rotation.push(roundRow([t, ...reading.rotation] as RotationRow))
      }
    }
    for (const fn of this.listeners) fn()
  }

  /** Start recording a take now (`t0` on the event clock). */
  beginTake(label: TakeLabel, hold: Hold, t0: number = performance.now(), date: Date = new Date()): void {
    this.take = { label, hold, startedAt: date.toISOString(), t0, cueMs: null, samples: [], rotation: [] }
  }

  /** Mark when the reader was told to go, on the same clock as beginTake(). */
  markCue(t: number = performance.now()): void {
    if (this.take) this.take.cueMs = Math.round((t - this.take.t0) * 10) / 10
  }

  endTake(): Take | null {
    const open = this.take
    this.take = null
    if (!open) return null
    const take: Take = {
      label: open.label,
      hold: open.hold,
      startedAt: open.startedAt,
      cueMs: open.cueMs,
      samples: open.samples,
    }
    if (open.rotation.length) take.rotation = open.rotation
    return take
  }

  /** Abandon the open take without keeping it. */
  cancelTake(): void {
    this.take = null
  }
}
