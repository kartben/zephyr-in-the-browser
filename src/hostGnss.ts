/** Browser end of the NMEA-over-UART GNSS bridge (uart1 RX). */

import * as hostUart1 from '@/hostUart1'
import * as hostTmcm3216 from '@/hostTmcm3216'

export interface GnssFix {
  latitude: number
  longitude: number
  altitude: number
  speed: number
  bearing: number
  satellites: number
}

const DEFAULT_FIX: GnssFix = {
  latitude: 48.8566,
  longitude: 2.3522,
  altitude: 35,
  speed: 0,
  bearing: 0,
  satellites: 8,
}

let fix = DEFAULT_FIX
let transmitter: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

export function attach(mod: unknown) {
  detach()
  hostUart1.attach(mod)
  if (available()) {
    transmit()
    transmitter = setInterval(transmit, 1000)
  }
  notify()
}

export function detach() {
  if (transmitter !== undefined) clearInterval(transmitter)
  transmitter = undefined
  hostTmcm3216.detach()
  hostUart1.detach()
  notify()
}

export function available(): boolean {
  return hostUart1.feedAvailable()
}

export function getSnapshot(): GnssFix {
  return fix
}

export function setFix(update: Partial<GnssFix>) {
  fix = {
    latitude: clamp(finite(update.latitude, fix.latitude), -90, 90),
    longitude: clamp(finite(update.longitude, fix.longitude), -180, 180),
    altitude: clamp(finite(update.altitude, fix.altitude), -1000, 100000),
    speed: clamp(finite(update.speed, fix.speed), 0, 2000),
    bearing: ((finite(update.bearing, fix.bearing) % 360) + 360) % 360,
    satellites: Math.round(clamp(finite(update.satellites, fix.satellites), 0, 99)),
  }
  transmit()
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/*
 * "Follow browser location" lives here, not in the panel that toggles it: the
 * geolocation watch must survive the panel collapsing, popping out, or the
 * dock rearranging its rows — following is a property of the fix source, not
 * of whichever widget happens to be showing it.
 */
let following = false
let stopWatch: (() => void) | undefined
let watchError = ''

export function followingBrowser(): boolean {
  return following
}

/** Last geolocation error while following, '' when none. */
export function locationError(): string {
  return watchError
}

export function setFollowBrowser(on: boolean): void {
  if (on === following) return
  following = on
  if (on) {
    stopWatch = watchBrowserPosition((message) => {
      if (watchError === message) return
      watchError = message
      notify()
    })
  } else {
    stopWatch?.()
    stopWatch = undefined
    watchError = ''
  }
  notify()
}

function finite(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function notify() {
  for (const fn of listeners) fn()
}

function coordinate(value: number, latitude: boolean): [string, string] {
  const absolute = Math.abs(value)
  const degrees = Math.floor(absolute)
  const minutes = (absolute - degrees) * 60
  const degreeWidth = latitude ? 2 : 3
  const hemisphere = latitude ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E'
  return [
    `${String(degrees).padStart(degreeWidth, '0')}${minutes.toFixed(4).padStart(7, '0')}`,
    hemisphere,
  ]
}

function checksum(body: string) {
  let value = 0
  for (let index = 0; index < body.length; index += 1) value ^= body.charCodeAt(index)
  return value.toString(16).toUpperCase().padStart(2, '0')
}

function sentence(body: string) {
  return `$${body}*${checksum(body)}\r\n`
}

/** Emit one standards-compliant GGA/RMC fix over the emulated UART. */
function transmit() {
  // TMCM-3216 owns uart1 while its sample is running — do not spam NMEA into TMCL.
  if (hostTmcm3216.isActive()) return
  if (!hostUart1.feedAvailable()) return

  const now = new Date()
  const time =
    `${String(now.getUTCHours()).padStart(2, '0')}` +
    `${String(now.getUTCMinutes()).padStart(2, '0')}` +
    `${String(now.getUTCSeconds()).padStart(2, '0')}.00`
  const date =
    `${String(now.getUTCDate()).padStart(2, '0')}` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCFullYear() % 100).padStart(2, '0')}`
  const [latitude, northSouth] = coordinate(fix.latitude, true)
  const [longitude, eastWest] = coordinate(fix.longitude, false)
  const satellites = String(fix.satellites).padStart(2, '0')
  const knots = fix.speed * 1.943844

  const payload =
    sentence(
      `GPGGA,${time},${latitude},${northSouth},${longitude},${eastWest},1,${satellites},0.9,${fix.altitude.toFixed(1)},M,0.0,M,,`,
    ) +
    sentence(
      `GPRMC,${time},A,${latitude},${northSouth},${longitude},${eastWest},${knots.toFixed(1)},${fix.bearing.toFixed(1)},${date},,,A`,
    )

  const bytes = new Uint8Array(payload.length)
  for (let index = 0; index < payload.length; index += 1) bytes[index] = payload.charCodeAt(index)
  hostUart1.feed(bytes)
}

export function watchBrowserPosition(onError: (message: string) => void): () => void {
  if (!navigator.geolocation) {
    onError('Browser geolocation is unavailable')
    return () => {}
  }

  const id = navigator.geolocation.watchPosition(
    ({ coords }) => {
      onError('')
      setFix({
        latitude: coords.latitude,
        longitude: coords.longitude,
        altitude: coords.altitude ?? fix.altitude,
        speed: coords.speed ?? fix.speed,
        bearing: coords.heading ?? fix.bearing,
      })
    },
    (error) => onError(error.message),
    { enableHighAccuracy: true, maximumAge: 1000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
