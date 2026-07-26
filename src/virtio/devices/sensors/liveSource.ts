/**
 * Browser sources a simulated sensor channel can follow. Tilt prefers
 * devicemotion; deviceorientation is only a fallback because β≈±90° gimbal
 * locks on upright phones.
 */

import type { LiveSourceKind } from './model'

export interface LiveSourceInfo {
  label: string
}

export const LIVE_SOURCES: Record<LiveSourceKind, LiveSourceInfo> = {
  'orientation-x': { label: 'device tilt' },
  'orientation-y': { label: 'device tilt' },
  'orientation-z': { label: 'device tilt' },
  battery: { label: 'battery level' },
}

export type LiveSourceGroup = 'orientation' | 'battery'

export function sourceGroupOf(kind: LiveSourceKind): LiveSourceGroup {
  return kind === 'battery' ? 'battery' : 'orientation'
}

export const SOURCE_GROUPS: Record<LiveSourceGroup, LiveSourceInfo> = {
  orientation: { label: 'device tilt' },
  battery: { label: 'battery level' },
}

const G = 9.80665

interface PermissionCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

/**
 * iOS Safari 13+ gates motion/orientation behind an explicit grant on the
 * constructor. Every other browser fires the events unprompted, so this is
 * absent there.
 */
export function orientationNeedsPermission(): boolean {
  const motion = window.DeviceMotionEvent as unknown as PermissionCtor | undefined
  const orient = window.DeviceOrientationEvent as unknown as PermissionCtor | undefined
  return (
    typeof motion?.requestPermission === 'function' ||
    typeof orient?.requestPermission === 'function'
  )
}

/**
 * Must be called synchronously from a user gesture (e.g. a click handler),
 * or iOS Safari treats the request as unprompted and denies it outright.
 */
export async function requestOrientationPermission(): Promise<'granted' | 'denied'> {
  const motion = window.DeviceMotionEvent as unknown as PermissionCtor | undefined
  const orient = window.DeviceOrientationEvent as unknown as PermissionCtor | undefined
  try {
    if (typeof motion?.requestPermission === 'function') {
      return await motion.requestPermission()
    }
    if (typeof orient?.requestPermission === 'function') {
      return await orient.requestPermission()
    }
    return 'granted'
  } catch {
    return 'denied'
  }
}

/**
 * Safari inverts `accelerationIncludingGravity` relative to the W3C / Android
 * convention (face-up Z ≈ −g instead of +g). `requestPermission` existing on
 * the motion/orientation constructors is the reliable Safari signal.
 */
export function motionGravityIsInverted(): boolean {
  return orientationNeedsPermission()
}

type OrientationAxis = 'orientation-x' | 'orientation-y' | 'orientation-z'

export type GravitySample = Record<OrientationAxis, number>

/** Map browser samples to chip axes; handle Safari signs and legacy iOS g-units. */
export function gravityFromMotion(
  x: number | null | undefined,
  y: number | null | undefined,
  z: number | null | undefined,
  invert = false,
): GravitySample | null {
  if (x == null || y == null || z == null) return null
  if (![x, y, z].every(Number.isFinite)) return null

  let ax = x
  let ay = y
  let az = z
  const mag = Math.hypot(ax, ay, az)
  // Older iOS builds reported ~1.0 face-up rather than ~9.8 m/s².
  if (mag > 0.1 && mag < 2.5) {
    ax *= G
    ay *= G
    az *= G
  }
  if (invert) {
    ax = -ax
    ay = -ay
    az = -az
  }
  return {
    'orientation-x': ax,
    'orientation-y': ay,
    'orientation-z': az,
  }
}

/**
 * Fallback when `devicemotion` is missing: project gravity from Euler tilt.
 * Fine for gentle desk tilts; unstable near β = ±90° (phone upright).
 */
export function gravityFromOrientation(
  betaDeg: number | null | undefined,
  gammaDeg: number | null | undefined,
): GravitySample | null {
  if (betaDeg == null || gammaDeg == null) return null
  const beta = (betaDeg * Math.PI) / 180
  const gamma = (gammaDeg * Math.PI) / 180
  return {
    'orientation-x': -G * Math.sin(gamma),
    'orientation-y': G * Math.sin(beta) * Math.cos(gamma),
    'orientation-z': G * Math.cos(beta) * Math.cos(gamma),
  }
}

export function startLiveSource(kind: LiveSourceKind, push: (value: number) => void): () => void {
  if (kind === 'battery') return startBattery(push)
  return startOrientation(kind, push)
}

function startBattery(push: (value: number) => void): () => void {
  type BatteryManager = EventTarget & { level: number }
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  if (!nav.getBattery) return () => {}

  let battery: BatteryManager | null = null
  let onLevel: (() => void) | null = null
  void nav.getBattery().then((b) => {
    battery = b
    onLevel = () => push(b.level * 100)
    onLevel()
    b.addEventListener('levelchange', onLevel)
  })
  return () => {
    if (battery && onLevel) battery.removeEventListener('levelchange', onLevel)
  }
}

function startOrientation(kind: OrientationAxis, push: (value: number) => void): () => void {
  return startOrientationGroup((axis, value) => {
    if (axis === kind) push(value)
  })
}

/** One sample feeds every axis; prefer motion to avoid Euler gimbal lock. */
export function startOrientationGroup(
  push: (axis: OrientationAxis, value: number) => void,
): () => void {
  const invert = motionGravityIsInverted()
  let usedMotion = false
  let stopped = false
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined

  const emit = (sample: GravitySample) => {
    push('orientation-x', sample['orientation-x'])
    push('orientation-y', sample['orientation-y'])
    push('orientation-z', sample['orientation-z'])
  }

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity
    if (!a) return
    const sample = gravityFromMotion(a.x, a.y, a.z, invert)
    if (!sample) return
    if (!usedMotion) {
      usedMotion = true
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
      // Drop the Euler path once the real accelerometer is flowing.
      window.removeEventListener('deviceorientation', onOrient)
    }
    emit(sample)
  }

  const onOrient = (e: DeviceOrientationEvent) => {
    // Once motion is flowing, drop the Euler path — that is what jumps on phones.
    if (usedMotion) return
    const sample = gravityFromOrientation(e.beta, e.gamma)
    if (sample) emit(sample)
  }

  window.addEventListener('devicemotion', onMotion)
  // Attach orientation immediately as a soft fallback for desktops / browsers
  // without motion, but give motion a short head start so the first samples
  // on a phone do not come from the unstable Euler projection.
  fallbackTimer = setTimeout(() => {
    fallbackTimer = undefined
    if (stopped || usedMotion) return
    window.addEventListener('deviceorientation', onOrient)
  }, 250)

  return () => {
    stopped = true
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
    window.removeEventListener('devicemotion', onMotion)
    window.removeEventListener('deviceorientation', onOrient)
  }
}
