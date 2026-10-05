import { describe, expect, it } from 'vitest'
import {
  MotionCapture,
  SETTLE_READINGS,
  decideNormalization,
  medianInterval,
  normalizeMotion,
  readingFromEvent,
  type RawReading,
} from './recorder'

const G = 9.80665

function rest(t: number, z = G): RawReading {
  return { t, x: 0, y: 0, z, rotation: null }
}

/** A capture fed SETTLE_READINGS readings at rest, 16 ms apart, ending at t = 0. */
function settled(inverted = false, z = G) {
  const capture = new MotionCapture(new EventTarget(), inverted)
  for (let i = SETTLE_READINGS; i > 0; i--) capture.push(rest(-16 * i, z))
  return capture
}

describe('decideNormalization', () => {
  it('leaves m/s² alone and scales readings reported in g', () => {
    expect(decideNormalization([9.8, 9.81, 9.79], false)).toEqual({ inverted: false, scaledFromG: false })
    expect(decideNormalization([1.0, 0.99, 1.01], true)).toEqual({ inverted: true, scaledFromG: true })
  })
})

describe('normalizeMotion', () => {
  it('scales g to m/s² and flips Safari’s signs', () => {
    expect(normalizeMotion(0, 0, 1, { inverted: false, scaledFromG: true })).toEqual([0, 0, G])
    const flipped = normalizeMotion(1, -2, -G, { inverted: true, scaledFromG: false })
    expect(flipped[0]).toBe(-1)
    expect(flipped[1]).toBe(2)
    expect(flipped[2]).toBe(G)
  })
})

describe('medianInterval', () => {
  it('measures the event rate from timestamps', () => {
    expect(medianInterval([0, 16, 33, 50, 66])).toBe(17)
    expect(medianInterval([0, 16])).toBeNull()
  })
})

describe('readingFromEvent', () => {
  it('reads acceleration and a complete rotation rate', () => {
    const e = {
      timeStamp: 1234,
      accelerationIncludingGravity: { x: 0.1, y: 0.2, z: G },
      rotationRate: { alpha: 1, beta: 2, gamma: 3 },
    } as unknown as DeviceMotionEvent
    expect(readingFromEvent(e)).toEqual({ t: 1234, x: 0.1, y: 0.2, z: G, rotation: [1, 2, 3] })
  })

  it('skips events without readings, and partial rotation rates', () => {
    expect(readingFromEvent({ accelerationIncludingGravity: null } as unknown as DeviceMotionEvent)).toBeNull()
    expect(
      readingFromEvent({ accelerationIncludingGravity: { x: NaN, y: 0, z: G } } as unknown as DeviceMotionEvent),
    ).toBeNull()
    const partial = readingFromEvent(
      {
        timeStamp: 0,
        accelerationIncludingGravity: { x: 0, y: 0, z: G },
        rotationRate: { alpha: null, beta: 2, gamma: 3 },
      } as unknown as DeviceMotionEvent,
      () => 99,
    )
    expect(partial).toEqual({ t: 99, x: 0, y: 0, z: G, rotation: null })
  })
})

describe('MotionCapture', () => {
  it('decides the unit from readings at rest before it records', () => {
    const capture = new MotionCapture(new EventTarget(), false)
    capture.beginTake('wing', 'recommended', -1000)
    for (let i = 0; i < SETTLE_READINGS - 1; i++) capture.push(rest(i))
    expect(capture.ready).toBe(false)
    capture.push(rest(100))
    expect(capture.ready).toBe(true)
    // Nothing before the decision made it into the take.
    expect(capture.endTake()?.samples).toEqual([[1100, 0, 0, 9.807]])
  })

  it('records a take on the take’s own clock, with the cue', () => {
    const capture = settled()
    capture.beginTake('ring', 'natural', 1000, new Date('2026-10-05T08:00:00Z'))
    capture.push(rest(900)) // before the take started
    capture.push({ t: 1016, x: 1, y: 2, z: 3, rotation: [10, 20, 30] })
    capture.markCue(4000)
    capture.push({ t: 4016.04, x: -1, y: -2, z: -3, rotation: null })
    expect(capture.endTake()).toEqual({
      label: 'ring',
      hold: 'natural',
      startedAt: '2026-10-05T08:00:00.000Z',
      cueMs: 3000,
      samples: [
        [16, 1, 2, 3],
        [3016, -1, -2, -3],
      ],
      rotation: [[16, 10, 20, 30]],
    })
    expect(capture.endTake()).toBeNull()
  })

  it('keeps a fast stroke’s dip in m/s² rather than taking it for g', () => {
    // liveSource decides per reading, so a magnitude of 1.5 m/s² would read as
    // 1.5 g there. Decided once at rest, it stays what it is.
    const capture = settled()
    capture.beginTake('wing', 'recommended', 0)
    capture.push({ t: 10, x: 0, y: 0.9, z: 1.2, rotation: null })
    expect(capture.endTake()?.samples).toEqual([[10, 0, 0.9, 1.2]])
  })

  it('scales a browser that reports g, and flips Safari', () => {
    const capture = settled(true, -1)
    expect(capture.normalization).toEqual({ inverted: true, scaledFromG: true })
    expect(capture.latest?.[2]).toBeCloseTo(G, 5)
  })

  it('drops an abandoned take', () => {
    const capture = settled()
    capture.beginTake('slope', 'recommended', 0)
    capture.push(rest(5))
    capture.cancelTake()
    expect(capture.endTake()).toBeNull()
  })

  it('listens on its target and tells subscribers', () => {
    const target = new EventTarget()
    const capture = new MotionCapture(target, false)
    let calls = 0
    capture.subscribe(() => calls++)
    capture.start()
    const e = new Event('devicemotion')
    Object.defineProperty(e, 'accelerationIncludingGravity', { value: { x: 0, y: 0, z: G } })
    target.dispatchEvent(e)
    expect(calls).toBe(1)
    expect(capture.latest).toEqual([0, 0, G])
    capture.stop()
    target.dispatchEvent(e)
    expect(calls).toBe(1)
  })
})
