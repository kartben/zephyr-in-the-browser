/**
 * Map Zephyr `gpio-buzzer` GPIO activity to Vibration API + Web Audio.
 * Lives outside the dock panel so short tones and collapsed rows still work.
 * `enable()` arms browser audio/vibrate (autoplay / sticky activation).
 */

import {
  getBuzzers,
  isBuzzerOn,
  subscribeOutputs,
} from '@/hostGpio'

const VIBRATE_PREF_KEY = 'zephyr.buzzer.vibrateEnabled'

/** Minimum latch so brief GPIO pulses still register. */
export const MIN_PULSE_MS = 200

/** Vibrate pulse used while arming host feedback. */
const UNLOCK_VIBRATE_MS = 400

/** Long pattern while sounding — avoids cancelling short pulses via setInterval. */
const VIBRATE_ON_MS = 120
const VIBRATE_OFF_MS = 40
const VIBRATE_CYCLES = 50 // ~8 s; stopFeedback cancels early

const BUZZ_FREQ_HZ = 2400
const BUZZ_GAIN = 0.12
/** Confirmation tone length when arming audio. */
const UNLOCK_CHIRP_MS = 120

export interface BuzzerSnapshot {
  /** Latched active (at least MIN_PULSE_MS). */
  sounding: boolean
  /** Raw pin at active level. */
  pinActive: boolean
  /** localStorage preference. */
  preferred: boolean
  /** Audio/vibrate armed this page load. */
  unlocked: boolean
  /** preferred && unlocked. */
  enabled: boolean
  /** navigator.vibrate exists. */
  vibrationSupported: boolean
  /** Last arming vibrate() returned true. */
  vibrationArmed: boolean
}

const listeners = new Set<() => void>()

let pinActive = false
let sounding = false
let preferred = readPref()
let unlocked = false
let vibrationArmed = false
let holdTimer: ReturnType<typeof setTimeout> | undefined
let chirpTimer: ReturnType<typeof setTimeout> | undefined
let audio: BuzzAudio | null = null
let gpioUnsub: (() => void) | undefined
/** Stable snapshot ref for useSyncExternalStore. */
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

function buildVibratePattern(): number[] {
  const pattern: number[] = []
  for (let i = 0; i < VIBRATE_CYCLES; i++) {
    pattern.push(VIBRATE_ON_MS, VIBRATE_OFF_MS)
  }
  return pattern
}

interface BuzzAudio {
  /** Arm AudioContext from a UI event. */
  unlock: () => void
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

  const kickOsc = (ac: AudioContext) => {
    if (osc) return
    gain = ac.createGain()
    gain.gain.value = BUZZ_GAIN
    gain.connect(ac.destination)
    osc = ac.createOscillator()
    osc.type = 'square'
    osc.frequency.value = BUZZ_FREQ_HZ
    osc.connect(gain)
    osc.start()
  }

  return {
    unlock() {
      const ac = ensure()
      // Chrome Android needs real output scheduled while arming, not just resume().
      try {
        const buf = ac.createBuffer(1, 1, ac.sampleRate)
        const src = ac.createBufferSource()
        src.buffer = buf
        src.connect(ac.destination)
        src.start(0)
      } catch {
        /* ignore */
      }
      void ac.resume()
    },
    start() {
      const ac = ensure()
      if (ac.state === 'running') {
        kickOsc(ac)
        return
      }
      void ac.resume().then(() => {
        if (ctx !== ac) return
        kickOsc(ac)
      })
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
    vibrationArmed,
  }
}

/** Only allocate a new snapshot object when fields change. */
function refreshSnapshot(): boolean {
  const next = buildSnapshot()
  const prev = snapshotCache
  if (
    prev.sounding === next.sounding &&
    prev.pinActive === next.pinActive &&
    prev.preferred === next.preferred &&
    prev.unlocked === next.unlocked &&
    prev.enabled === next.enabled &&
    prev.vibrationSupported === next.vibrationSupported &&
    prev.vibrationArmed === next.vibrationArmed
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
  try {
    navigator.vibrate?.(0)
  } catch {
    /* ignore */
  }
  audio?.stop()
}

function startFeedback() {
  if (!preferred || !unlocked) return
  audio ??= createBuzzAudio()
  audio.start()
  if (!vibrationSupported()) return
  // One long pattern; stopFeedback cancels with vibrate(0).
  const ok = navigator.vibrate?.(buildVibratePattern())
  if (ok === false) vibrationArmed = false
}

function setSounding(next: boolean) {
  if (sounding !== next) {
    sounding = next
    if (next) startFeedback()
    else stopFeedback()
  }
  notify()
}

function syncFromGpio() {
  const next = anyPinActive()
  if (next === pinActive) return
  pinActive = next

  if (next) {
    if (holdTimer !== undefined) clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      holdTimer = undefined
      if (!pinActive) setSounding(false)
    }, MIN_PULSE_MS)
    setSounding(true)
  } else if (holdTimer === undefined) {
    setSounding(false)
  } else {
    notify()
  }
}

function ensureWatching() {
  if (gpioUnsub) return
  gpioUnsub = subscribeOutputs(syncFromGpio)
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

/** Latched sounding for UI shake. */
export function isSounding(): boolean {
  ensureWatching()
  return sounding
}

/** Arm host sound/haptics; must run from a UI event (browser activation). */
export function enable() {
  ensureWatching()
  preferred = true
  unlocked = true
  writePref(true)

  audio ??= createBuzzAudio()
  audio.unlock()
  if (chirpTimer !== undefined) clearTimeout(chirpTimer)
  audio.start()
  chirpTimer = setTimeout(() => {
    chirpTimer = undefined
    if (!sounding) audio?.stop()
  }, UNLOCK_CHIRP_MS)

  if (vibrationSupported()) {
    try {
      vibrationArmed = navigator.vibrate?.(UNLOCK_VIBRATE_MS) === true
    } catch {
      vibrationArmed = false
    }
  } else {
    vibrationArmed = false
  }

  if (sounding) startFeedback()
  notify()
}

export function disable() {
  preferred = false
  writePref(false)
  if (chirpTimer !== undefined) {
    clearTimeout(chirpTimer)
    chirpTimer = undefined
  }
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
  if (chirpTimer !== undefined) clearTimeout(chirpTimer)
  chirpTimer = undefined
  stopFeedback()
  audio?.dispose()
  audio = null
  gpioUnsub?.()
  gpioUnsub = undefined
  pinActive = false
  sounding = false
  preferred = false
  unlocked = false
  vibrationArmed = false
  listeners.clear()
  refreshSnapshot()
}
