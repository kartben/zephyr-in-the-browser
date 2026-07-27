import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_POLL_MS,
  isRegistered,
  register,
  resetForTests,
  unregister,
} from '@/hostPoll'

beforeEach(() => {
  vi.useFakeTimers()
  resetForTests()
})

afterEach(() => {
  resetForTests()
  vi.useRealTimers()
})

describe('hostPoll', () => {
  it('runs every registered task on the shared beat', () => {
    const a = vi.fn()
    const b = vi.fn()
    register('a', HOST_POLL_MS, a)
    register('b', HOST_POLL_MS, b)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('honours per-task periods on the shared beat', () => {
    const slow = vi.fn()
    const fast = vi.fn()
    register('fast', HOST_POLL_MS, fast)
    register('slow', 500, slow)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(fast).toHaveBeenCalledTimes(1)
    expect(slow).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(400)
    expect(fast).toHaveBeenCalledTimes(5)
    expect(slow).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(fast).toHaveBeenCalledTimes(6)
    expect(slow).toHaveBeenCalledTimes(2)
  })

  it('stops the timer when the last task unregisters', () => {
    const spy = vi.spyOn(globalThis, 'clearInterval')
    const stop = register('only', HOST_POLL_MS, () => {})
    expect(isRegistered('only')).toBe(true)
    stop()
    expect(isRegistered('only')).toBe(false)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('replaces a task when re-registered under the same id', () => {
    const first = vi.fn()
    const second = vi.fn()
    register('x', HOST_POLL_MS, first)
    register('x', HOST_POLL_MS, second)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps beating when one task throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    register('bad', HOST_POLL_MS, bad)
    register('good', HOST_POLL_MS, good)

    vi.advanceTimersByTime(HOST_POLL_MS)
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('rejects periods below the shared beat', () => {
    expect(() => register('too-fast', 1, () => {})).toThrow(/below the 100ms shared beat/)
    expect(isRegistered('too-fast')).toBe(false)
  })

  it('unregister is a no-op for unknown ids', () => {
    expect(() => unregister('missing')).not.toThrow()
  })
})
