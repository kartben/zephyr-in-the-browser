import { describe, expect, it } from 'vitest'
import { fitEllipsis } from './queueGraphText'

describe('fitEllipsis', () => {
  it('returns the full string when it already fits', () => {
    expect(fitEllipsis('sensor_0', 200)).toBe('sensor_0')
  })

  it('truncates with an ellipsis when wider than maxPx', () => {
    const out = fitEllipsis('aggregator_worker_long', 48)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan('aggregator_worker_long'.length)
  })

  it('handles tiny widths without throwing', () => {
    expect(fitEllipsis('hello', 1)).toBe('…')
    expect(fitEllipsis('hello', 0)).toBe('')
  })
})
