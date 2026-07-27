import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StepperAxis } from '@/dts'

const gpio = vi.hoisted(() => {
  let outputs = 0
  let steppers: StepperAxis[] = []
  const listeners = new Set<() => void>()
  return {
    getSteppers: () => steppers,
    isOutputHigh: (pin: number) => (outputs & (1 << pin)) !== 0,
    setOutputs(mask: number) {
      if (mask === outputs) return
      outputs = mask
      for (const fn of listeners) fn()
    },
    setPin(pin: number, high: boolean) {
      const next = high ? outputs | (1 << pin) : outputs & ~(1 << pin)
      this.setOutputs(next)
    },
    setSteppers(next: StepperAxis[]) {
      steppers = next
      for (const fn of listeners) fn()
    },
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    reset() {
      outputs = 0
      steppers = []
      listeners.clear()
    },
  }
})

vi.mock('@/hostGpio', () => ({
  getSteppers: () => gpio.getSteppers(),
  isOutputHigh: (pin: number) => gpio.isOutputHigh(pin),
  subscribe: (fn: () => void) => gpio.subscribe(fn),
  subscribeOutputs: (fn: () => void) => gpio.subscribe(fn),
}))

import { getSnapshot, resetForTests, subscribe } from '@/hostStepper'

const AXIS: StepperAxis = {
  id: '/motion-controller',
  label: 'Browser stepper',
  stepPin: 6,
  stepActiveHigh: true,
  dirPin: 7,
  dirActiveHigh: true,
  invertDirection: false,
}

/** One non-dual-edge step: STEP high then low; position counts on the falling edge. */
function pulseStep(dirHigh: boolean) {
  gpio.setPin(7, dirHigh)
  gpio.setPin(6, true)
  gpio.setPin(6, false)
}

describe('hostStepper', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] })
    gpio.reset()
    resetForTests()
    gpio.setSteppers([AXIS])
  })

  afterEach(() => {
    resetForTests()
    gpio.reset()
    vi.useRealTimers()
  })

  it('counts falling STEP edges as positive when DIR is high', () => {
    expect(getSnapshot().axes[0]?.position).toBe(0)
    pulseStep(true)
    expect(getSnapshot().axes[0]?.position).toBe(1)
    pulseStep(true)
    expect(getSnapshot().axes[0]?.position).toBe(2)
  })

  it('decrements when DIR is low', () => {
    getSnapshot()
    pulseStep(false)
    expect(getSnapshot().axes[0]?.position).toBe(-1)
    expect(getSnapshot().axes[0]?.directionPositive).toBe(false)
  })

  it('honors invert-direction', () => {
    gpio.setSteppers([{ ...AXIS, invertDirection: true }])
    getSnapshot()
    pulseStep(true)
    expect(getSnapshot().axes[0]?.position).toBe(-1)
  })

  it('does not count a rising-only edge', () => {
    getSnapshot()
    gpio.setPin(7, true)
    gpio.setPin(6, true)
    expect(getSnapshot().axes[0]?.position).toBe(0)
  })

  it('reports velocity while stepping', () => {
    getSnapshot()
    pulseStep(true)
    vi.advanceTimersByTime(10)
    pulseStep(true)
    vi.advanceTimersByTime(10)
    pulseStep(true)
    const rate = getSnapshot().axes[0]?.stepsPerSec ?? 0
    expect(rate).toBeGreaterThan(50)
    expect(getSnapshot().axes[0]?.moving).toBe(true)
  })

  it('notifies subscribers on step edges', () => {
    const fn = vi.fn()
    const unsub = subscribe(fn)
    pulseStep(true)
    expect(fn).toHaveBeenCalled()
    unsub()
  })

  it('returns a stable snapshot reference while idle', () => {
    const a = getSnapshot()
    const b = getSnapshot()
    expect(a).toBe(b)
  })
})
