/**
 * Decode Zephyr DT GPIO flag cells (`include/zephyr/dt-bindings/gpio/gpio.h`)
 * for the GPIO controller table: its "active" column in plain words, and the
 * devicetree macros behind them for the cell's tooltip.
 */

const GPIO_ACTIVE_LOW = 1 << 0
const GPIO_SINGLE_ENDED = 1 << 1
const GPIO_LINE_OPEN_DRAIN = 1 << 2
const GPIO_PULL_UP = 1 << 4
const GPIO_PULL_DOWN = 1 << 5

/**
 * The flags cell in words, e.g. `high`, `low, pull-up`. The level that means
 * "on" comes first, since that is what the column is named for; it used to
 * read `AH` and `AL PU`, which only a datasheet reader could decode.
 */
export function formatGpioFlags(flags: number): string {
  const words: string[] = []
  words.push(flags & GPIO_ACTIVE_LOW ? 'low' : 'high')
  if (flags & GPIO_PULL_UP) words.push('pull-up')
  if (flags & GPIO_PULL_DOWN) words.push('pull-down')
  if (flags & GPIO_SINGLE_ENDED) {
    words.push(flags & GPIO_LINE_OPEN_DRAIN ? 'open drain' : 'open source')
  }
  return words.join(', ')
}

/**
 * The same cell as a devicetree would spell it, e.g.
 * `GPIO_ACTIVE_LOW | GPIO_PULL_UP`: the term a reader looks up in the board's
 * `.dts`, kept for the tooltip.
 */
export function gpioFlagMacros(flags: number): string {
  const names: string[] = []
  names.push(flags & GPIO_ACTIVE_LOW ? 'GPIO_ACTIVE_LOW' : 'GPIO_ACTIVE_HIGH')
  if (flags & GPIO_PULL_UP) names.push('GPIO_PULL_UP')
  if (flags & GPIO_PULL_DOWN) names.push('GPIO_PULL_DOWN')
  if (flags & GPIO_SINGLE_ENDED) {
    names.push(flags & GPIO_LINE_OPEN_DRAIN ? 'GPIO_OPEN_DRAIN' : 'GPIO_OPEN_SOURCE')
  }
  return names.join(' | ')
}
