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

function startOrientation(
  kind: 'orientation-x' | 'orientation-y' | 'orientation-z',
  push: (value: number) => void,
): () => void {
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return
    const beta = (e.beta * Math.PI) / 180 // front-back tilt
    const gamma = (e.gamma * Math.PI) / 180 // left-right tilt
    if (kind === 'orientation-x') push(-G * Math.sin(gamma))
    else if (kind === 'orientation-y') push(G * Math.sin(beta) * Math.cos(gamma))
    else push(G * Math.cos(beta) * Math.cos(gamma))
  }
  window.addEventListener('deviceorientation', onOrient)
  return () => window.removeEventListener('deviceorientation', onOrient)
}
