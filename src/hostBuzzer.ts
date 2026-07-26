/**
 * Browser-side gpio-buzzer feedback: Vibration API + Web Audio buzz.
 *
 * The guest drives a stock Zephyr `gpio-buzzer` over the existing GPIO bridge.
 * Short tones (the packaged `samples/drivers/buzzer/tone` beeps are 150–400 ms)
 * can come and go before React commits an effect, and collapsing the dock body
 * unmounts the old panel controller — so feedback lives here, outside the
 * mount lifecycle, with a minimum pulse latch so a single active sample is
 * still felt and heard.
 *
 * `enable()` must run from a user gesture (sticky activation for vibrate,
 * autoplay policy for AudioContext). A localStorage pref remembers the choice
 * across reloads, but each session still needs one tap to unlock.
 */

import {
  getBuzzers,
  isBuzzerOn,
  subscribe as subscribeGpio,
} from '@/hostGpio'

const VIBRATE_PREF_KEY = 'zephyr.buzzer.vibrateEnabled'

/** Hold "sounding" at least this long after a rising edge so short tones register. */
export const MIN_PULSE_MS = 200

/** Repeating buzz while the latched line stays active past the first pulse. */
const VIBRATE_PATTERN: number[] = [100, 50]
const VIBRATE_INTERVAL_MS = 150

const BUZZ_FREQ_HZ = 800
const BUZZ_GAIN = 0.08

export interface BuzzerSnapshot {
  /** Latched activity — true for at least MIN_PULSE_MS after pin goes active. */
  sounding: boolean
  /** Raw: any gpio-buzzer pin currently at its active level. */
  pinActive: boolean
  /** User prefers feedback on (localStorage). */
  preferred: boolean
  /** This page load has had a gesture unlock. */
  unlocked: boolean
  /** Feedback is armed: preferred && unlocked. */
  enabled: boolean
  /** `navigator.vibrate` exists (often a no-op on desktop). */
  vibrationSupported: boolean
}

const listeners = new Set<() => void>()

let pinActive = false
let sounding = false
let preferred = readPref()
let unlocked = false
let holdTimer: ReturnType<typeof setTimeout> | undefined
let vibrateTimer: ReturnType<typeof setInterval> | undefined
let audio: BuzzAudio | null = null
let gpioUnsub: (() => void) | undefined
/**
 * Cached for useSyncExternalStore: getSnapshot must return the same reference
 * until something actually changes, or React re-renders forever and the tab dies.
 */
let snapshotCache: BuzzerSnapshot = buildSnapshot()

function readPref(): boolean {
  try {
    return localStorage.getItem(VIBRATE_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writePref(on: boolean) {
  try {
    localStorage.setItem(VIBRATE_PREF_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function vibrationSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

interface BuzzAudio {
  start: () => void
  stop: () => void
  dispose: () => void
}

function createBuzzAudio(): BuzzAudio {
  let ctx: AudioContext | null = null
  let osc: OscillatorNode | null = null
  let gain: GainNode | null = null

  const ensure = () => {
    if (ctx) return ctx
    const root = globalThis as typeof globalThis & {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const AC = root.AudioContext ?? root.webkitAudioContext
    if (!AC) throw new Error('Web Audio API unavailable')
    ctx = new AC()
    return ctx
  }

  return {
    start() {
      const ac = ensure()
      void ac.resume()
      if (osc) return
      gain = ac.createGain()
      gain.gain.value = BUZZ_GAIN
      gain.connect(ac.destination)
      osc = ac.createOscillator()
      osc.type = 'square'
      osc.frequency.value = BUZZ_FREQ_HZ
      osc.connect(gain)
      osc.start()
    },
    stop() {
      try {
        osc?.stop()
      } catch {
        /* already stopped */
      }
      osc?.disconnect()
      gain?.disconnect()
      osc = null
      gain = null
    },
    dispose() {
      this.stop()
      void ctx?.close()
      ctx = null
    },
  }
}

function buildSnapshot(): BuzzerSnapshot {
  return {
    sounding,
    pinActive,
    preferred,
    unlocked,
    enabled: preferred && unlocked,
    vibrationSupported: vibrationSupported(),
  }
}

/** Rebuild only when a field changes so Object.is stays stable across polls. */
function refreshSnapshot(): boolean {
  const next = buildSnapshot()
  const prev = snapshotCache
  if (
    prev.sounding === next.sounding &&
    prev.pinActive === next.pinActive &&
    prev.preferred === next.preferred &&
    prev.unlocked === next.unlocked &&
    prev.enabled === next.enabled &&
    prev.vibrationSupported === next.vibrationSupported
  ) {
    return false
  }
  snapshotCache = next
  return true
}

function notify() {
  if (!refreshSnapshot()) return
  for (const fn of listeners) fn()
}

function anyPinActive(): boolean {
  return getBuzzers().some((pin) => isBuzzerOn(pin))
}

function stopFeedback() {
  if (vibrateTimer !== undefined) {
    clearInterval(vibrateTimer)
    vibrateTimer = undefined
  }
  navigator.vibrate?.(0)
  audio?.stop()
}

function startFeedback() {
  if (!preferred || !unlocked) return
  audio ??= createBuzzAudio()
  audio.start()
  if (!vibrationSupported()) return
  // One solid pulse covers the latch window; refresh if the line stays active.
  navigator.vibrate?.(MIN_PULSE_MS)
  if (vibrateTimer === undefined) {
    vibrateTimer = setInterval(() => {
      navigator.vibrate?.(VIBRATE_PATTERN)
    }, VIBRATE_INTERVAL_MS)
  }
}

function setSounding(next: boolean) {
  if (sounding !== next) {
    sounding = next
    if (next) startFeedback()
    else stopFeedback()
  }
  // Always refresh — callers may have flipped pinActive under a latched tone.
  notify()
}

function syncFromGpio() {
  const next = anyPinActive()
  if (next === pinActive) return
  pinActive = next

  if (next) {
    // Rising edge: latch on and (re)arm the minimum hold.
    if (holdTimer !== undefined) clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      holdTimer = undefined
      if (!pinActive) setSounding(false)
    }, MIN_PULSE_MS)
    setSounding(true)
  } else if (holdTimer === undefined) {
    // Falling edge after the hold already expired.
    setSounding(false)
  } else {
    // Still inside the hold window — pinActive flipped; keep sounding until
    // the timer fires. Refresh the cached snapshot so UI can show raw pin state.
    notify()
  }
}

function ensureWatching() {
  if (gpioUnsub) return
  gpioUnsub = subscribeGpio(syncFromGpio)
  syncFromGpio()
}

export function getSnapshot(): BuzzerSnapshot {
  ensureWatching()
  return snapshotCache
}

export function subscribe(fn: () => void): () => void {
  ensureWatching()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Latched sounding — prefer this over raw pin level for UI shake. */
export function isSounding(): boolean {
  ensureWatching()
  return sounding
}

/**
 * Unlock vibrate + AudioContext. Must run synchronously from a click/tap.
 * Turns preference on and, if the buzzer is already sounding, starts feedback
 * under the same user activation.
 */
export function enable() {
  preferred = true
  unlocked = true
  writePref(true)
  audio ??= createBuzzAudio()
  // Prime the context even when idle so the next tone is not swallowed by
  // a suspended AudioContext.
  audio.start()
  audio.stop()
  if (vibrationSupported()) navigator.vibrate?.(VIBRATE_PATTERN)
  if (sounding) startFeedback()
  notify()
}

export function disable() {
  preferred = false
  writePref(false)
  stopFeedback()
  notify()
}

export function toggle() {
  if (preferred && unlocked) disable()
  else enable()
}

/** Test helper: drop timers, audio, and GPIO watch. */
export function resetForTests() {
  if (holdTimer !== undefined) clearTimeout(holdTimer)
  holdTimer = undefined
  stopFeedback()
  audio?.dispose()
  audio = null
  gpioUnsub?.()
  gpioUnsub = undefined
  pinActive = false
  sounding = false
  preferred = false
  unlocked = false
  listeners.clear()
  refreshSnapshot()
}
