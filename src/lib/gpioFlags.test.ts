import { describe, expect, it } from 'vitest'
import { formatGpioFlags, gpioFlagMacros } from './gpioFlags'

describe('formatGpioFlags', () => {
  it('defaults to active-high', () => {
    expect(formatGpioFlags(0)).toBe('high')
  })

  it('spells out active-low and the pulls', () => {
    expect(formatGpioFlags(1)).toBe('low')
    expect(formatGpioFlags(1 | (1 << 4))).toBe('low, pull-up')
    expect(formatGpioFlags(1 << 5)).toBe('high, pull-down')
  })

  it('spells out open-drain / open-source', () => {
    // GPIO_OPEN_DRAIN = SINGLE_ENDED | LINE_OPEN_DRAIN
    expect(formatGpioFlags((1 << 1) | (1 << 2))).toBe('high, open drain')
    // GPIO_OPEN_SOURCE = SINGLE_ENDED only
    expect(formatGpioFlags(1 << 1)).toBe('high, open source')
  })
})

describe('gpioFlagMacros', () => {
  it('names the devicetree macros, for the tooltip', () => {
    expect(gpioFlagMacros(0)).toBe('GPIO_ACTIVE_HIGH')
    expect(gpioFlagMacros(1 | (1 << 4))).toBe('GPIO_ACTIVE_LOW | GPIO_PULL_UP')
    expect(gpioFlagMacros((1 << 1) | (1 << 2))).toBe('GPIO_ACTIVE_HIGH | GPIO_OPEN_DRAIN')
    expect(gpioFlagMacros(1 << 1)).toBe('GPIO_ACTIVE_HIGH | GPIO_OPEN_SOURCE')
  })
})
