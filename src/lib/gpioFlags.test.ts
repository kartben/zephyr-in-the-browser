import { describe, expect, it } from 'vitest'
import { formatGpioFlags } from './gpioFlags'

describe('formatGpioFlags', () => {
  it('defaults to active-high', () => {
    expect(formatGpioFlags(0)).toBe('AH')
  })

  it('decodes active-low and pulls', () => {
    expect(formatGpioFlags(1)).toBe('AL')
    expect(formatGpioFlags(1 | (1 << 4))).toBe('AL PU')
    expect(formatGpioFlags(1 << 5)).toBe('AH PD')
  })

  it('decodes open-drain / open-source', () => {
    // GPIO_OPEN_DRAIN = SINGLE_ENDED | LINE_OPEN_DRAIN
    expect(formatGpioFlags((1 << 1) | (1 << 2))).toBe('AH OD')
    // GPIO_OPEN_SOURCE = SINGLE_ENDED only
    expect(formatGpioFlags(1 << 1)).toBe('AH OS')
  })
})
