import { describe, expect, it, vi } from 'vitest'

import { createAdxl345 } from './adxl345'
import { STANDARD_GRAVITY } from './helpers'
import type { SensorChip } from './model'
import type { RecordingClip } from './recordings'
import { startClipReplay, type ReplayClock, type ReplayTarget } from './replay'

const TARGET: ReplayTarget = { channels: ['accel_x', 'accel_y', 'accel_z'], dataReg: 0x32 }

const CLIP: RecordingClip = {
  id: 'demo',
  label: 'Demo',
  samples: [
    [0, 0, 1],
    [0.5, -0.25, 1.5],
    [-1, 0.75, 0.5],
    [0, 0, 1],
  ],
}

/** A part as adxl345_init leaves it: ±8 g, 10-bit, 64 LSB/g. */
function initialisedAccel(): SensorChip {
  const chip = createAdxl345()
  chip.write(Uint8Array.of(0x31, 0x02))
  return chip
}

/** One driver fetch: poll INT_SOURCE, then burst X/Y/Z. Returns g. */
function fetch(chip: SensorChip): number[] {
  chip.write(Uint8Array.of(0x30))
  chip.startRead()
  chip.read(1)
  chip.write(Uint8Array.of(0x32))
  chip.startRead()
  const d = chip.read(6)
  return [0, 2, 4].map((i) => ((((d[i + 1]! << 8) | d[i]!) << 16) >> 16) / 64)
}

/** A clock the test winds by hand. */
function manualClock() {
  let now = 0
  let tick: (() => void) | null = null
  const clock: ReplayClock = {
    now: () => now,
    setInterval: (fn) => {
      tick = fn
      return 1
    },
    clearInterval: () => {
      tick = null
    },
  }
  return {
    clock,
    advance(ms: number, steps: number) {
      for (let i = 0; i < steps; i++) {
        now += ms
        tick?.()
      }
    },
    running: () => tick !== null,
  }
}

describe('startClipReplay', () => {
  it('hands each guest fetch the next sample, in order', () => {
    const chip = initialisedAccel()
    const { clock } = manualClock()
    const onDone = vi.fn()
    startClipReplay(chip, CLIP, TARGET, { periodMs: 40, clock, onDone })

    for (const sample of CLIP.samples) {
      const got = fetch(chip)
      sample.forEach((g, axis) => expect(Math.abs(got[axis]! - g)).toBeLessThanOrEqual(1 / 128))
    }
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('does not step on reads of other registers', () => {
    const chip = initialisedAccel()
    const { clock } = manualClock()
    startClipReplay(chip, CLIP, TARGET, { periodMs: 40, clock })
    for (let i = 0; i < 5; i++) {
      chip.write(Uint8Array.of(0x30))
      chip.startRead()
    }
    expect(fetch(chip)).toEqual([0, 0, 1])
    expect(fetch(chip)[0]).toBeCloseTo(0.5, 1)
  })

  it('leaves the card on the clip end and stops listening when done', () => {
    const chip = initialisedAccel()
    const { clock, running } = manualClock()
    startClipReplay(chip, CLIP, TARGET, { periodMs: 40, clock })
    for (let i = 0; i < CLIP.samples.length; i++) fetch(chip)
    expect(running()).toBe(false)
    chip.setChannel('accel_x', 3)
    expect(fetch(chip)[0]).toBeCloseTo(3 / STANDARD_GRAVITY, 1)
  })

  it('eases in from wherever the sliders were left', () => {
    const chip = initialisedAccel()
    chip.setChannel('accel_x', STANDARD_GRAVITY)
    chip.setChannel('accel_z', 0)
    const { clock } = manualClock()
    startClipReplay(chip, CLIP, TARGET, { periodMs: 40, clock, rampSamples: 4 })
    const xs = [0, 1, 2, 3].map(() => fetch(chip)[0]!)
    expect(xs[0]).toBeLessThan(1)
    expect(xs[0]).toBeGreaterThan(xs[3]!)
    expect(xs[3]).toBeCloseTo(0, 1)
    // Then the clip itself, from its first sample.
    expect(fetch(chip)).toEqual([0, 0, 1])
  })

  it('plays on a timer when no guest reads', () => {
    const chip = initialisedAccel()
    const { clock, advance } = manualClock()
    const onDone = vi.fn()
    startClipReplay(chip, CLIP, TARGET, { periodMs: 40, idleMs: 200, clock, onDone })
    advance(40, 4)
    expect(chip.getChannel('accel_x')).toBe(0)
    advance(40, 1)
    expect(chip.getChannel('accel_z')).toBeCloseTo(STANDARD_GRAVITY)
    advance(40, 1)
    expect(chip.getChannel('accel_x')).toBeCloseTo(0.5 * STANDARD_GRAVITY)
    advance(40, 2)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('stops early without calling onDone', () => {
    const chip = initialisedAccel()
    const { clock, running } = manualClock()
    const onDone = vi.fn()
    const replay = startClipReplay(chip, CLIP, TARGET, { periodMs: 40, clock, onDone })
    fetch(chip)
    replay.stop()
    expect(running()).toBe(false)
    expect(fetch(chip)).toEqual([0, 0, 1])
    expect(onDone).not.toHaveBeenCalled()
  })
})
