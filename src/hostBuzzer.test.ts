import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gpio = vi.hoisted(() => {
  let high = false
  const listeners = new Set<() => void>()
  return {
    getBuzzers: () => [{ id: 5, label: 'Browser buzzer', activeHigh: true }],
    isBuzzerOn: () => high,
    setHigh(v: boolean) {
      if (high === v) return
      high = v
      for (const fn of listeners) fn()
    },
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    reset() {
      high = false
      listeners.clear()
    },
  }
})

vi.mock('@/hostGpio', () => ({
  getBuzzers: () => gpio.getBuzzers(),
  isBuzzerOn: () => gpio.isBuzzerOn(),
  subscribe: (fn: () => void) => gpio.subscribe(fn),
  subscribeOutputs: (fn: () => void) => gpio.subscribe(fn),
}))

import {
  MIN_PULSE_MS,
  disable,
  enable,
  getSnapshot,
  resetForTests,
  subscribe,
} from '@/hostBuzzer'

function stubAudio() {
  class FakeAudioContext {
    sampleRate = 48000
    state: AudioContextState = 'running'
    createGain() {
      return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }
    }
    createOscillator() {
      return {
        type: 'square',
        frequency: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
    }
    createBuffer(channels: number, length: number, sampleRate: number) {
      return { channels, length, sampleRate }
    }
    createBufferSource() {
      return {
        buffer: null as unknown,
        connect: vi.fn(),
        start: vi.fn(),
      }
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

describe('hostBuzzer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gpio.reset()
    resetForTests()
    stubAudio()
    vi.stubGlobal('navigator', {
      vibrate: vi.fn(() => true),
    })
  })

  afterEach(() => {
    resetForTests()
    gpio.reset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('latches sounding for MIN_PULSE_MS after a brief pin pulse', () => {
    expect(getSnapshot().sounding).toBe(false)

    gpio.setHigh(true)
    expect(getSnapshot().sounding).toBe(true)
    expect(getSnapshot().pinActive).toBe(true)

    // Tone ends after 50 ms — still latched.
    vi.advanceTimersByTime(50)
    gpio.setHigh(false)
    expect(getSnapshot().pinActive).toBe(false)
    expect(getSnapshot().sounding).toBe(true)

    vi.advanceTimersByTime(MIN_PULSE_MS - 50 - 1)
    expect(getSnapshot().sounding).toBe(true)

    vi.advanceTimersByTime(1)
    expect(getSnapshot().sounding).toBe(false)
  })

  it('stays sounding while the pin remains active past the hold', () => {
    // Start the GPIO watch before the edge so the hold timer arms on rise.
    expect(getSnapshot().sounding).toBe(false)

    gpio.setHigh(true)
    expect(getSnapshot().sounding).toBe(true)

    vi.advanceTimersByTime(MIN_PULSE_MS + 50)
    expect(getSnapshot().sounding).toBe(true)
    expect(getSnapshot().pinActive).toBe(true)

    gpio.setHigh(false)
    expect(getSnapshot().sounding).toBe(false)
  })

  it('keeps feedback disarmed until enable() arms the session', () => {
    expect(getSnapshot().unlocked).toBe(false)
    expect(getSnapshot().enabled).toBe(false)

    enable()
    expect(getSnapshot().unlocked).toBe(true)
    expect(getSnapshot().preferred).toBe(true)
    expect(getSnapshot().enabled).toBe(true)

    disable()
    expect(getSnapshot().preferred).toBe(false)
    expect(getSnapshot().enabled).toBe(false)
    // Session stays armed so a later enable() is still one UI event.
    expect(getSnapshot().unlocked).toBe(true)
  })

  it('does not vibrate on pin activity before enable', () => {
    const vibrate = navigator.vibrate as unknown as ReturnType<typeof vi.fn>
    gpio.setHigh(true)
    expect(vibrate).not.toHaveBeenCalled()

    enable()
    expect(vibrate).toHaveBeenCalled()
  })

  it('marks vibrationArmed from the arming vibrate() result', () => {
    const vibrate = navigator.vibrate as unknown as ReturnType<typeof vi.fn>
    vibrate.mockReturnValueOnce(true)
    enable()
    expect(getSnapshot().vibrationArmed).toBe(true)
    expect(getSnapshot().vibrationSupported).toBe(true)

    disable()
    vibrate.mockReturnValueOnce(false)
    enable()
    expect(getSnapshot().vibrationArmed).toBe(false)
    expect(getSnapshot().enabled).toBe(true)
  })

  it('starts a long vibrate pattern once when sounding after enable', () => {
    enable()
    const vibrate = navigator.vibrate as unknown as ReturnType<typeof vi.fn>
    vibrate.mockClear()

    gpio.setHigh(true)
    expect(vibrate).toHaveBeenCalledTimes(1)
    const pattern = vibrate.mock.calls[0]?.[0]
    expect(Array.isArray(pattern)).toBe(true)
    expect((pattern as number[]).length).toBeGreaterThan(2)
  })

  it('notifies subscribers when sounding changes', () => {
    const fn = vi.fn()
    const unsub = subscribe(fn)
    gpio.setHigh(true)
    expect(fn).toHaveBeenCalled()
    unsub()
  })

  it('returns a stable snapshot reference while idle (useSyncExternalStore)', () => {
    const a = getSnapshot()
    const b = getSnapshot()
    expect(a).toBe(b)
  })

  it('returns a new snapshot object only when state changes', () => {
    const idle = getSnapshot()
    gpio.setHigh(true)
    const active = getSnapshot()
    expect(active).not.toBe(idle)
    expect(active.sounding).toBe(true)
    expect(getSnapshot()).toBe(active)
  })
})
