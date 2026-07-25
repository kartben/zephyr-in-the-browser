import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  gravityFromMotion,
  gravityFromOrientation,
  startOrientationGroup,
} from './liveSource'

const G = 9.80665

function expectSample(
  sample: Record<string, number> | null,
  expected: { x: number; y: number; z: number },
) {
  expect(sample).not.toBeNull()
  expect(sample!['orientation-x']).toBeCloseTo(expected.x, 5)
  expect(sample!['orientation-y']).toBeCloseTo(expected.y, 5)
  expect(sample!['orientation-z']).toBeCloseTo(expected.z, 5)
}

describe('gravityFromOrientation', () => {
  it('reads +g on Z when the device is flat', () => {
    expectSample(gravityFromOrientation(0, 0), { x: 0, y: 0, z: G })
  })

  it('shows the upright-phone gimbal lock: γ flipping ±90° swings X by 2g', () => {
    // β≈90° with γ≈±90° is what Safari reports when a phone is held portrait;
    // sin(±90°)=±1 so X jumps between −g and +g for a tiny attitude change.
    const left = gravityFromOrientation(90, -90)!
    const right = gravityFromOrientation(90, 90)!
    expect(left['orientation-x']).toBeCloseTo(G, 5)
    expect(right['orientation-x']).toBeCloseTo(-G, 5)
    expect(Math.abs(right['orientation-x'] - left['orientation-x'])).toBeCloseTo(2 * G, 5)
  })
})

describe('gravityFromMotion', () => {
  it('passes W3C face-up samples through unchanged', () => {
    expectSample(gravityFromMotion(0, 0, G), { x: 0, y: 0, z: G })
  })

  it("inverts Safari's opposite-of-W3C signs", () => {
    expectSample(gravityFromMotion(0, 0, -G, true), { x: 0, y: 0, z: G })
  })

  it('scales legacy g-unit samples up to m/s²', () => {
    // Safari face-up in g-units is z≈−1; invert restores the ADXL +g rest pose.
    expectSample(gravityFromMotion(0, 0, -1, true), { x: 0, y: 0, z: G })
  })

  it('keeps X near zero for an upright phone (no Euler swing)', () => {
    // Portrait, screen toward user: gravity on +Y in the W3C frame.
    const sample = gravityFromMotion(0.05, G, 0.02)!
    expect(sample['orientation-x']).toBeCloseTo(0.05, 5)
    expect(sample['orientation-y']).toBeCloseTo(G, 5)
    expect(Math.abs(sample['orientation-x'])).toBeLessThan(1)
  })

  it('rejects incomplete samples', () => {
    expect(gravityFromMotion(null, 0, G)).toBeNull()
    expect(gravityFromMotion(0, undefined, G)).toBeNull()
  })
})

describe('startOrientationGroup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubWindow() {
    const listeners = new Map<string, EventListener>()
    const win = {
      DeviceMotionEvent: class {},
      DeviceOrientationEvent: class {},
      addEventListener: (type: string, listener: EventListener) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    vi.stubGlobal('window', win)
    return { listeners, win }
  }

  it('feeds axes from accelerationIncludingGravity and ignores later Euler flips', () => {
    vi.useFakeTimers()
    const { listeners } = stubWindow()

    const values: Record<string, number> = {}
    const stop = startOrientationGroup((axis, value) => {
      values[axis] = value
    })

    // Let the Euler fallback attach, then prove motion takes over and sticks.
    vi.advanceTimersByTime(250)
    listeners.get('deviceorientation')?.({ beta: 0, gamma: 0 } as DeviceOrientationEvent)
    expect(values['orientation-z']).toBeCloseTo(G, 5)

    listeners.get('devicemotion')?.(
      {
        accelerationIncludingGravity: { x: 0.1, y: G, z: 0.05 },
      } as DeviceMotionEvent,
    )
    expect(values['orientation-x']).toBeCloseTo(0.1, 5)
    expect(values['orientation-y']).toBeCloseTo(G, 5)
    expect(values['orientation-z']).toBeCloseTo(0.05, 5)

    // The γ flip that used to slam Accel X between ±g must not win anymore.
    listeners.get('deviceorientation')?.({ beta: 90, gamma: 90 } as DeviceOrientationEvent)
    expect(values['orientation-x']).toBeCloseTo(0.1, 5)

    stop()
  })

  it('falls back to deviceorientation when motion never arrives', () => {
    vi.useFakeTimers()
    const { listeners } = stubWindow()

    const values: Record<string, number> = {}
    startOrientationGroup((axis, value) => {
      values[axis] = value
    })

    expect(listeners.has('deviceorientation')).toBe(false)
    vi.advanceTimersByTime(250)
    expect(listeners.has('deviceorientation')).toBe(true)

    listeners.get('deviceorientation')?.({ beta: 0, gamma: 0 } as DeviceOrientationEvent)
    expect(values['orientation-z']).toBeCloseTo(G, 5)
  })
})
