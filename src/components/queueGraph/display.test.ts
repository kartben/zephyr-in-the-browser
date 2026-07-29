import { describe, expect, it } from 'vitest'
import { capacityFillFraction, compactCapacity, compactCount } from './display'

describe('capacity display', () => {
  it('computes one honest occupancy fraction regardless of capacity size', () => {
    expect(capacityFillFraction(3, 8)).toBe(0.375)
    expect(capacityFillFraction(1_536, 4_096)).toBe(0.375)
    expect(capacityFillFraction(3, 1_048_576)).toBeCloseTo(0.000002861, 9)
    expect(capacityFillFraction(9, 8)).toBe(1)
  })

  it('compacts only values too large for fixed node labels', () => {
    expect(compactCount(4_096)).toBe('4,096')
    expect(compactCount(1_048_576)).toBe('1M')
    expect(compactCapacity(12_288, 1_048_576)).toBe('12.3K/1M')
  })
})
