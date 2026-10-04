import { describe, expect, it } from 'vitest'
import { threadNameFilter, unmatchedThreadNames } from '@/tours/threadFilter'

const NAMES = ['sysworkq', 'aggregator', 'consumer0', 'consumer1', 'sensor_temp', 'Philosopher 4']

describe('threadNameFilter', () => {
  it('lets every thread through when a step names none', () => {
    expect(NAMES.filter(threadNameFilter([]))).toEqual(NAMES)
  })

  it('matches names exactly, and `*` as any run of characters', () => {
    expect(NAMES.filter(threadNameFilter(['aggregator', 'consumer*']))).toEqual([
      'aggregator',
      'consumer0',
      'consumer1',
    ])
    expect(NAMES.filter(threadNameFilter(['*_temp', 'Philosopher 4']))).toEqual([
      'sensor_temp',
      'Philosopher 4',
    ])
    // No partial matches without a `*`, and regex characters are literal.
    expect(NAMES.filter(threadNameFilter(['consumer', 'sensor.temp']))).toEqual([])
  })
})

describe('unmatchedThreadNames', () => {
  it('lists the names no thread has', () => {
    expect(unmatchedThreadNames(['aggregator', 'consumer*', 'storage'], NAMES)).toEqual(['storage'])
    expect(unmatchedThreadNames([], NAMES)).toEqual([])
  })
})
