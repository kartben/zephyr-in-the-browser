import { describe, expect, it } from 'vitest'
import { whenFires } from '@/tours/when'

const hitsThatFire = (when: string | null, upTo = 12) =>
  Array.from({ length: upTo }, (_, i) => i + 1).filter((hits) => whenFires(when, hits).fires)

describe('whenFires', () => {
  it('fires on every hit with no condition', () => {
    expect(hitsThatFire(null, 3)).toEqual([1, 2, 3])
    expect(hitsThatFire('', 3)).toEqual([1, 2, 3])
  })

  it('understands `first`', () => {
    expect(hitsThatFire('first', 4)).toEqual([1])
    expect(hitsThatFire('once', 4)).toEqual([1])
  })

  it('compares hit counts', () => {
    expect(hitsThatFire('hits == 3', 5)).toEqual([3])
    expect(hitsThatFire('hits >= 4', 5)).toEqual([4, 5])
    expect(hitsThatFire('hits < 3', 5)).toEqual([1, 2])
    expect(hitsThatFire('hits != 2', 3)).toEqual([1, 3])
  })

  it('takes every nth hit', () => {
    expect(hitsThatFire('hits % 4 == 0', 12)).toEqual([4, 8, 12])
    expect(hitsThatFire('hits % 5 == 1', 11)).toEqual([1, 6, 11])
  })

  it('reads a bare number as the hit to stop on', () => {
    expect(hitsThatFire('3', 5)).toEqual([3])
  })

  it('fires — and says so — when the condition is nonsense', () => {
    expect(whenFires('when the moon is full', 1)).toEqual({ fires: true, invalid: true })
  })
})
