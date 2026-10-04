import { describe, expect, it } from 'vitest'
import { appOfTour, isTourId } from '@/tours/tourId'

describe('tour ids', () => {
  it.each(['blinky', 'basic_button', 'basic_button.msgq', 'msgq_lab.lost-alarm', 'blinky_trace'])(
    '%s is a tour id',
    (id) => {
      expect(isTourId(id)).toBe(true)
    },
  )

  it.each([
    '',
    '.msgq',
    'basic_button.',
    'basic_button..msgq',
    'basic_button.msgq.more',
    'blinky.tour.md',
    'samples/basic/blinky',
    'Blinky tour',
    '-blinky',
  ])('%j is not', (id) => {
    expect(isTourId(id)).toBe(false)
  })

  it('names its app before the dot', () => {
    expect(appOfTour('basic_button')).toBe('basic_button')
    expect(appOfTour('basic_button.msgq')).toBe('basic_button')
    // A slug may say `trace` without naming a traced twin.
    expect(appOfTour('blinky.my_trace')).toBe('blinky')
  })
})
