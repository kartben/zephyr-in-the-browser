/**
 * Browser end of the `qemu,host-sensor` bridge.
 *
 * The QEMU device exports one entry point, `qemu_host_sensor_set(channel,
 * value)`, which writes a sample into memory the guest reads over MMIO. That
 * memory is shared between the page and the pthread QEMU runs on, so this is a
 * plain call — nothing is proxied and the guest's read path never enters JS.
 *
 * Deliberately not part of the PtyBackend seam: the bridge is optional, and a
 * backend that has no sensor device should not have to know it exists.
 */

/** Must match qhs_channel_index() in zephyr-module/drivers/qemu_host_sensor.c. */
export const CHANNELS = [
  { id: 0, label: 'Accel X', unit: 'm/s²', zephyr: 'accel_x', min: -20, max: 20 },
  { id: 1, label: 'Accel Y', unit: 'm/s²', zephyr: 'accel_y', min: -20, max: 20 },
  { id: 2, label: 'Accel Z', unit: 'm/s²', zephyr: 'accel_z', min: -20, max: 20 },
  { id: 3, label: 'Temperature', unit: '°C', zephyr: 'ambient_temp', min: -40, max: 85 },
  { id: 4, label: 'Light', unit: 'lx', zephyr: 'light', min: 0, max: 1000 },
  { id: 5, label: 'Humidity', unit: '%', zephyr: 'humidity', min: 0, max: 100 },
  { id: 6, label: 'Pressure', unit: 'kPa', zephyr: 'press', min: 80, max: 110 },
  { id: 7, label: 'Battery', unit: '%', zephyr: 'gauge_state_of_charge', min: 0, max: 100 },
] as const

export type ChannelId = (typeof CHANNELS)[number]['id']

interface SensorExports {
  _qemu_host_sensor_set?: (channel: number, value: number) => void
}

let exports: SensorExports | null = null
const listeners = new Set<() => void>()

/** Latest value pushed per channel, so the UI can render without reading back. */
const values = new Map<number, number>()

/**
 * Called by the qemu backend once its module is live. A build without the
 * device patch simply lacks the export, which `available()` reports.
 */
export function attach(mod: unknown) {
  exports = mod as SensorExports
  notify()
}

export function detach() {
  exports = null
  values.clear()
  notify()
}

export function available(): boolean {
  return typeof exports?._qemu_host_sensor_set === 'function'
}

export function get(channel: number): number | undefined {
  return values.get(channel)
}

export function set(channel: number, value: number) {
  if (!Number.isFinite(value)) return
  values.set(channel, value)
  exports?._qemu_host_sensor_set?.(channel, value)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

// ---------------------------------------------------------------------------
// Live sources. Each returns a teardown function, and each is best-effort:
// availability varies by browser, platform and permission state, so a source
// that cannot start is not an error.
// ---------------------------------------------------------------------------

/** Battery level -> state-of-charge. Chromium-only; absent elsewhere. */
export async function startBattery(): Promise<() => void> {
  type BatteryManager = EventTarget & { level: number }
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  if (!nav.getBattery) return () => {}

  const battery = await nav.getBattery()
  const push = () => set(7, battery.level * 100)
  push()
  battery.addEventListener('levelchange', push)
  return () => battery.removeEventListener('levelchange', push)
}

/**
 * Device orientation -> accelerometer axes, by projecting gravity onto the
 * device frame. Needs a real tilt sensor, so on a desktop this stays quiet.
 */
export function startOrientation(): () => void {
  const G = 9.80665
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return
    const beta = (e.beta * Math.PI) / 180 // front-back tilt
    const gamma = (e.gamma * Math.PI) / 180 // left-right tilt
    set(0, -G * Math.sin(gamma))
    set(1, G * Math.sin(beta) * Math.cos(gamma))
    set(2, G * Math.cos(beta) * Math.cos(gamma))
  }
  window.addEventListener('deviceorientation', onOrient)
  return () => window.removeEventListener('deviceorientation', onOrient)
}
