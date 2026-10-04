import { describe, expect, it, vi } from 'vitest'
import { selectSample, setSelector } from '@/lib/selection'

describe('selection bus', () => {
  it('hands the request to whoever registered', () => {
    const fn = vi.fn()
    const off = setSelector(fn)
    expect(selectSample({ sampleId: 'basic_button' })).toBe(true)
    expect(fn).toHaveBeenCalledWith({ sampleId: 'basic_button' })
    off()
  })

  it('says so when nobody is listening', () => {
    expect(selectSample({ sampleId: 'blinky' })).toBe(false)
  })

  it('does not let a stale unregister drop the current handler', () => {
    // Only the newest registration answers, and unregistering an older one
    // must leave it in place.
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = setSelector(first)
    const offSecond = setSelector(second)
    offFirst()
    selectSample({ sampleId: 'blinky' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    offSecond()
    expect(selectSample({ sampleId: 'blinky' })).toBe(false)
  })
})
