/**
 * Plays a recorded clip into a sensor's x/y/z channels, paced by the guest.
 *
 * The part has live data registers and no FIFO, so a sample only counts once
 * the guest reads it. Each read message that starts at the data register takes
 * the next sample, so the guest sees the recording at its own sampling rate
 * however fast the emulator runs, and a model that needs every sample in order
 * (the Magic Wand's 128-sample window) gets every one. With no guest reading
 * (the mock backend, a guest paused in the debugger), a timer steps at the
 * recording's rate instead, so the card still plays.
 */

import { STANDARD_GRAVITY } from './helpers'
import type { SensorChip } from './model'
import type { RecordingClip, Vec3 } from './recordings'

export interface ReplayTarget {
  /** Channel keys for x, y and z, in m/s². */
  channels: readonly [string, string, string]
  /** The register a guest fetch of a fresh sample starts at. */
  dataReg: number
}

export interface ReplayClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface ReplayOptions {
  /** Timer step while no guest reads, ms: one recorded sample period. */
  periodMs: number
  /** Quiet time after the last guest read before the timer steps, ms. */
  idleMs?: number
  /** Samples to ease from the card's current values into the clip, if they differ. */
  rampSamples?: number
  /** Called once the guest (or the timer) has taken the last sample. */
  onDone?: () => void
  clock?: ReplayClock
}

export interface Replay {
  stop(): void
}

const browserClock: ReplayClock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** Cosine ease from `from` to `to`, `count` samples, ending on `to`. */
function ease(from: Vec3, to: Vec3, count: number): Vec3[] {
  const out: Vec3[] = []
  for (let k = 1; k <= count; k++) {
    const t = (1 - Math.cos((Math.PI * k) / count)) / 2
    out.push([
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ])
  }
  return out
}

export function startClipReplay(
  chip: SensorChip,
  clip: RecordingClip,
  target: ReplayTarget,
  opts: ReplayOptions,
): Replay {
  const clock = opts.clock ?? browserClock
  const idleMs = opts.idleMs ?? 1000

  const [kx, ky, kz] = target.channels
  const current: Vec3 = [
    chip.getChannel(kx) / STANDARD_GRAVITY,
    chip.getChannel(ky) / STANDARD_GRAVITY,
    chip.getChannel(kz) / STANDARD_GRAVITY,
  ]
  const first = clip.samples[0]
  const away = first !== undefined && current.some((v, axis) => Math.abs(v - first[axis]) > 0.02)
  const samples = away ? [...ease(current, first, opts.rampSamples ?? 10), ...clip.samples] : [...clip.samples]

  let index = 0
  let done = false
  let lastRead = clock.now()

  const end = () => {
    done = true
    unsubscribe()
    clock.clearInterval(timer)
  }

  const step = () => {
    if (done) return
    const sample = samples[index++]
    if (sample) {
      target.channels.forEach((key, axis) => chip.setChannel(key, sample[axis] * STANDARD_GRAVITY))
    }
    if (index >= samples.length) {
      end()
      opts.onDone?.()
    }
  }

  const unsubscribe = chip.onRead((pointer) => {
    if (pointer !== target.dataReg) return
    lastRead = clock.now()
    step()
  })
  const timer = clock.setInterval(() => {
    if (clock.now() - lastRead >= idleMs) step()
  }, opts.periodMs)

  if (samples.length === 0) step()

  return {
    stop() {
      if (!done) end()
    },
  }
}
