/**
 * Decode Zephyr DT GPIO flag cells (`include/zephyr/dt-bindings/gpio/gpio.h`)
 * into the compact tokens the GPIO controller table shows.
 */

const GPIO_ACTIVE_LOW = 1 << 0
const GPIO_SINGLE_ENDED = 1 << 1
const GPIO_LINE_OPEN_DRAIN = 1 << 2
const GPIO_PULL_UP = 1 << 4
const GPIO_PULL_DOWN = 1 << 5

/** Compact flag string for a DT `gpios` flags cell, e.g. `AH`, `AL PU`. */
export function formatGpioFlags(flags: number): string {
  const tokens: string[] = []
  tokens.push(flags & GPIO_ACTIVE_LOW ? 'AL' : 'AH')
  if (flags & GPIO_PULL_UP) tokens.push('PU')
  if (flags & GPIO_PULL_DOWN) tokens.push('PD')
  if (flags & GPIO_SINGLE_ENDED) {
    tokens.push(flags & GPIO_LINE_OPEN_DRAIN ? 'OD' : 'OS')
  }
  return tokens.join(' ')
}
