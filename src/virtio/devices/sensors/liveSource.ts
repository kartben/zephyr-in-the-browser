/**
 * Browser sensors a simulated channel can follow instead of its slider.
 *
 * Each source starts a best-effort subscription and pushes engineering-unit
 * values through a callback until stopped. Availability varies by browser,
 * platform and permission, so a source that cannot start simply never pushes —
 * that is not an error. The projection math is the same as the retired
 * qemu,host-sensor bridge used (src/hostSensor.ts); this is now its home.
 */

import type { LiveSourceKind } from './model'

export interface LiveSourceInfo {
  /** Shown next to the "follow" checkbox. */
  label: string
}

export const LIVE_SOURCES: Record<LiveSourceKind, LiveSourceInfo> = {
  'orientation-x': { label: 'device tilt' },
  'orientation-y': { label: 'device tilt' },
  'orientation-z': { label: 'device tilt' },
  battery: { label: 'battery level' },
}

/**
 * One browser sensor feeds several channels — the three orientation axes are
 * one physical tilt. Grouping is what lets a chip offer a single "follow
 * device tilt" toggle instead of three identical checkboxes.
 */
export type LiveSourceGroup = 'orientation' | 'battery'

export function sourceGroupOf(kind: LiveSourceKind): LiveSourceGroup {
  return kind === 'battery' ? 'battery' : 'orientation'
}

export const SOURCE_GROUPS: Record<LiveSourceGroup, LiveSourceInfo> = {
  orientation: { label: 'device tilt' },
  battery: { label: 'battery level' },
}

const G = 9.80665

/**
 * Start pushing values from `kind` into `push`. Returns a teardown function.
 * The orientation axes project gravity onto the device frame; battery reports
 * state-of-charge as a percentage.
 */
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

type OrientationAxis = 'orientation-x' | 'orientation-y' | 'orientation-z'

function projectOrientation(
  e: DeviceOrientationEvent,
): Record<OrientationAxis, number> | null {
  if (e.beta === null || e.gamma === null) return null
  const beta = (e.beta * Math.PI) / 180 // front-back tilt
  const gamma = (e.gamma * Math.PI) / 180 // left-right tilt
  return {
    'orientation-x': -G * Math.sin(gamma),
    'orientation-y': G * Math.sin(beta) * Math.cos(gamma),
    'orientation-z': G * Math.cos(beta) * Math.cos(gamma),
  }
}

function startOrientation(kind: OrientationAxis, push: (value: number) => void): () => void {
  const onOrient = (e: DeviceOrientationEvent) => {
    const projected = projectOrientation(e)
    if (projected) push(projected[kind])
  }
  window.addEventListener('deviceorientation', onOrient)
  return () => window.removeEventListener('deviceorientation', onOrient)
}

/**
 * One DeviceOrientationEvent feeds every axis. Prefer this over three
 * startLiveSource('orientation-*') calls: a single listener, and — when the
 * chip coalesces setChannel notifies — one React update per tilt sample
 * instead of three stacked ones competing with the qemu-wasm main loop.
 */
export function startOrientationGroup(
  push: (axis: OrientationAxis, value: number) => void,
): () => void {
  const onOrient = (e: DeviceOrientationEvent) => {
    const projected = projectOrientation(e)
    if (!projected) return
    push('orientation-x', projected['orientation-x'])
    push('orientation-y', projected['orientation-y'])
    push('orientation-z', projected['orientation-z'])
  }
  window.addEventListener('deviceorientation', onOrient)
  return () => window.removeEventListener('deviceorientation', onOrient)
}
