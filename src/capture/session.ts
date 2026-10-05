/**
 * A gesture capture session: what the capture page records and exports.
 *
 * The exported file is training data for the Magic Wand model
 * (docs/magic-wand-training.md). Samples are in the frame the page feeds the
 * guest's ADXL345 when a phone follows tilt (src/virtio/devices/sensors/
 * liveSource.ts): m/s², gravity included, +Z out of the screen, so a model
 * trained on them sees what the guest will read.
 */

export const CAPTURE_FORMAT = 'zitb-magic-wand-capture'
export const CAPTURE_VERSION = 1

export const GESTURES = ['wing', 'ring', 'slope'] as const
export type GestureLabel = (typeof GESTURES)[number]
export type TakeLabel = GestureLabel | 'negative' | 'idle'

export function isGesture(label: TakeLabel): label is GestureLabel {
  return (GESTURES as readonly string[]).includes(label)
}

/** [ms since the take started, x, y, z] in m/s². */
export type MotionRow = [number, number, number, number]
/** [ms since the take started, alpha, beta, gamma] in deg/s. */
export type RotationRow = [number, number, number, number]

/**
 * How the reader was asked to hold the phone. `recommended` matches what the
 * current model was trained on; `natural` is however they would hold it, which
 * is what a model that works for everyone has to cope with.
 */
export type Hold = 'recommended' | 'natural'

export const HOLDS: Record<Hold, string> = {
  recommended: 'Flat, screen up, charging port on your left',
  natural: 'However you would naturally hold it',
}

export interface Take {
  label: TakeLabel
  hold: Hold
  /** ISO time the take started. */
  startedAt: string
  /** When the reader was told to go, ms after the take started. Null for free takes. */
  cueMs: number | null
  samples: MotionRow[]
  /** Present when the browser reports a rotation rate. */
  rotation?: RotationRow[]
}

export interface DeviceInfo {
  userAgent: string
  /** From User-Agent Client Hints, where the browser has them (Chromium). */
  platform: string | null
  model: string | null
  mobile: boolean | null
  screen: [number, number]
  pixelRatio: number
}

export interface CaptureSession {
  format: typeof CAPTURE_FORMAT
  version: typeof CAPTURE_VERSION
  id: string
  createdAt: string
  device: DeviceInfo
  contributor: {
    handedness: 'right' | 'left' | null
  }
  /** How raw readings became `samples`: see normalizeMotion() in recorder.ts. */
  normalization: { inverted: boolean; scaledFromG: boolean } | null
  /** Median interval between motion events, as measured. */
  motionIntervalMs: number | null
  takes: Take[]
}

/** One take the page will ask for. */
export interface TakeSpec {
  label: TakeLabel
  /** Recording length after the cue (gestures) or in total (free takes), ms. */
  durationMs: number
}

/** The countdown before a gesture's cue. It is recorded too: still, then the move. */
export const COUNTDOWN_MS = 3000
export const GESTURE_MS = 3000
export const NEGATIVE_MS = 20_000
export const IDLE_MS = 10_000

export function takeSpec(label: TakeLabel): TakeSpec {
  const durationMs = label === 'negative' ? NEGATIVE_MS : label === 'idle' ? IDLE_MS : GESTURE_MS
  return { label, durationMs }
}

/**
 * One round: `reps` of each gesture in random order, then free movement and
 * stillness. Shuffled so practice and fatigue spread over every gesture rather
 * than favouring whichever comes last.
 */
export function planRound(reps = 5, random: () => number = Math.random): TakeSpec[] {
  const gestures: TakeSpec[] = []
  for (const label of GESTURES) {
    for (let i = 0; i < reps; i++) gestures.push(takeSpec(label))
  }
  for (let i = gestures.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[gestures[i], gestures[j]] = [gestures[j]!, gestures[i]!]
  }
  return [...gestures, takeSpec('negative'), takeSpec('idle')]
}

export function newSession(device: DeviceInfo, now = new Date(), random: () => number = Math.random): CaptureSession {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')
  const suffix = Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, '0')
  return {
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    id: `${stamp}-${suffix}`,
    createdAt: now.toISOString(),
    device,
    contributor: { handedness: null },
    normalization: null,
    motionIntervalMs: null,
    takes: [],
  }
}

export function countTakes(session: CaptureSession): Record<TakeLabel, number> {
  const counts: Record<TakeLabel, number> = { wing: 0, ring: 0, slope: 0, negative: 0, idle: 0 }
  for (const take of session.takes) counts[take.label]++
  return counts
}

/** Readings rounded to what the sensor resolves, so files stay small. */
export function roundRow<T extends number[]>(row: T): T {
  return row.map((v, i) => (i === 0 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000)) as T
}

export function sessionFileName(session: CaptureSession): string {
  return `magic-wand-${session.id}.json`
}

export function serializeSession(session: CaptureSession): string {
  return JSON.stringify(session)
}

/** Parse a session file, or say why it is not one. */
export function parseSession(text: string): CaptureSession {
  const value = JSON.parse(text) as Partial<CaptureSession>
  if (value.format !== CAPTURE_FORMAT) throw new Error('not a Magic Wand capture file')
  if (value.version !== CAPTURE_VERSION) throw new Error(`unsupported capture version ${value.version}`)
  if (!Array.isArray(value.takes)) throw new Error('capture file has no takes')
  return value as CaptureSession
}

const STORAGE_KEY = 'zitb.capture.session'

/**
 * Keep the session in this browser between takes, so a reload or a closed tab
 * loses nothing. Storage can be full, blocked or absent (private windows), and
 * then the page still works: the reader just has to export before leaving.
 */
export function saveSession(session: CaptureSession, storage: Storage | null = safeLocalStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(STORAGE_KEY, serializeSession(session))
    return true
  } catch {
    return false
  }
}

export function loadSession(storage: Storage | null = safeLocalStorage()): CaptureSession | null {
  if (!storage) return null
  try {
    const text = storage.getItem(STORAGE_KEY)
    return text ? parseSession(text) : null
  } catch {
    return null
  }
}

export function clearSession(storage: Storage | null = safeLocalStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
