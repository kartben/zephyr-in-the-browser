import { describe, expect, it } from 'vitest'
import { countOf, pinsUsed, traceCounts } from './countText'

describe('countOf', () => {
  it('says the noun, singular for one', () => {
    expect(countOf(1, 'button')).toBe('1 button')
    expect(countOf(2, 'button')).toBe('2 buttons')
    expect(countOf(0, 'breakpoint')).toBe('0 breakpoints')
  })
})

describe('traceCounts', () => {
  it('spells out events and threads', () => {
    expect(traceCounts(812, 3)).toBe('812 events · 3 threads')
    expect(traceCounts(1, 1)).toBe('1 event · 1 thread')
  })

  it('rounds a long count', () => {
    // The tracing_pipeline badge read "35821 evt · 10 thr".
    expect(traceCounts(35_821, 10)).toBe('35.8K events · 10 threads')
  })
})

describe('pinsUsed', () => {
  it('says what the two numbers are', () => {
    // It read "13 / 16" on the A53 shell.
    expect(pinsUsed(13, 16)).toBe('13 of 16 pins used')
  })
})
