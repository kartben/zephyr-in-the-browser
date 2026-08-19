/**
 * Browser end of the ESP32-C3's RTC controller, for the dock's power card.
 *
 * The one bridge on this board that carries nothing: it is a read-only window
 * onto `hw/misc/esp32c3_rtc_cntl.c`, which is where sleep happens. There is no
 * protocol and no round trip, because there is no question to ask: the model
 * updates a small struct when a sleep starts and when it ends, and this reads
 * it on the shared beat.
 *
 * It exists because sleep is otherwise invisible. A guest that enters light
 * sleep simply stops printing, and nothing in the UI distinguishes that from a
 * guest that crashed, one that is busy, or an emulator that wedged. The card
 * says which it is.
 */

import { HOST_POLL_MS, register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'

/** Byte offsets into Esp32C3RtcStatus. Must match hw/misc/esp32c3_rtc_cntl.c. */
const AREA = {
  magic: 0,
  version: 4,
  state: 8,
  resetReason: 12,
  sleepCount: 16,
  rejectCount: 20,
  wakeCause: 24,
  lastSleepUs: 28,
  totalSleepUs: 32,
  ticksLow: 36,
  ticksHigh: 40,
} as const

const AREA_MAGIC = 0x53435452 /* "RTCS" */
const AREA_VERSION = 1

/** Values of `state`, from the same file. */
export type PowerState = 'awake' | 'light-sleep' | 'deep-sleep'
const STATES: PowerState[] = ['awake', 'light-sleep', 'deep-sleep']

/**
 * ESP32C3ResetReason. Only the ones a guest here can actually produce are
 * named; anything else is shown as its number, which is what the datasheet
 * calls it anyway.
 */
const RESET_REASONS: Record<number, string> = {
  1: 'Power-on',
  3: 'Software (system)',
  5: 'Deep sleep',
  7: 'Watchdog (TG0)',
  9: 'Watchdog (RTC)',
  12: 'Software (CPU)',
  15: 'Brown-out',
}

export interface PowerSnapshot {
  available: boolean
  state: PowerState
  /** Human-readable reset reason, or null before anything is known. */
  resetReason: string | null
  sleepCount: number
  /** Sleeps the model refused because nothing was armed to end them. */
  rejectCount: number
  /** Duration the last sleep asked for, in microseconds. */
  lastSleepUs: number
  totalSleepUs: number
  /** RTC slow-clock counter, as of the last sleep, wake or guest read. */
  rtcTicks: number
}

const IDLE: PowerSnapshot = {
  available: false,
  state: 'awake',
  resetReason: null,
  sleepCount: 0,
  rejectCount: 0,
  lastSleepUs: 0,
  totalSleepUs: 0,
  rtcTicks: 0,
}

const POLL_ID = 'host-power-state'

interface PowerExports {
  _qemu_esp32c3_rtc_status?: () => number
  HEAPU8?: Uint8Array
}

let mod: PowerExports | null = null
let base = 0
let words: Int32Array | null = null
/** useSyncExternalStore compares with Object.is, so this is rebuilt on change. */
let snapshot: PowerSnapshot = IDLE
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function read(offset: number): number {
  return words![(base + offset) >> 2]! >>> 0
}

function sample() {
  if (!words) {
    discover()
    return
  }
  const next: PowerSnapshot = {
    available: true,
    state: STATES[read(AREA.state)] ?? 'awake',
    resetReason: RESET_REASONS[read(AREA.resetReason)] ?? `Reset ${read(AREA.resetReason)}`,
    sleepCount: read(AREA.sleepCount),
    rejectCount: read(AREA.rejectCount),
    lastSleepUs: read(AREA.lastSleepUs),
    totalSleepUs: read(AREA.totalSleepUs),
    // The counter is 48 bits; the low word alone wraps every ~8 hours of
    // guest time, so keep the high word rather than showing a jump.
    rtcTicks: read(AREA.ticksHigh) * 2 ** 32 + read(AREA.ticksLow),
  }
  const prev = snapshot
  if (
    prev.available === next.available &&
    prev.state === next.state &&
    prev.resetReason === next.resetReason &&
    prev.sleepCount === next.sleepCount &&
    prev.rejectCount === next.rejectCount &&
    prev.lastSleepUs === next.lastSleepUs &&
    prev.totalSleepUs === next.totalSleepUs &&
    prev.rtcTicks === next.rtcTicks
  ) {
    return
  }
  snapshot = next
  notify()
}

function discover() {
  const at = mod?._qemu_esp32c3_rtc_status?.() ?? 0
  const heap = mod?.HEAPU8
  if (!at || !heap) return

  const view = new Int32Array(heap.buffer)
  if ((view[at >> 2]! >>> 0) !== AREA_MAGIC) {
    console.warn('[power] RTC status block has the wrong magic; ignoring it')
    mod = null
    return
  }
  const version = view[(at + AREA.version) >> 2]!
  if (version !== AREA_VERSION) {
    console.warn(`[power] emulator speaks protocol ${version}, page speaks ${AREA_VERSION}`)
    mod = null
    return
  }
  base = at
  words = view
  sample()
}

/** Called by the qemu backend once its module is live. */
export function attach(instance: unknown) {
  detach()
  mod = instance as PowerExports | null
  registerPoll(POLL_ID, HOST_POLL_MS, sample)
  discover()
}

export function detach() {
  unregisterPoll(POLL_ID)
  const was = snapshot.available
  mod = null
  words = null
  base = 0
  snapshot = IDLE
  if (was) notify()
}

export function getSnapshot(): PowerSnapshot {
  return snapshot
}

export function available(): boolean {
  return snapshot.available
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
