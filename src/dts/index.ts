/** Public devicetree parsing, query, and insight surface. */

export { parseDts } from './parser'
export { DtsParseError } from './model'
export type { DtsCell, DtsDocument, DtsNode, DtsProperty, DtsValue } from './model'
export * from './query'
export { computeInsights, emphasisPanels } from './insights'
export type {
  DtsInsights,
  DtsPin,
  BuzzerPin,
  GpioController,
  I2cBus,
  I2cSlot,
  SpiBus,
  SpiSlot,
  UartBus,
  UartSlot,
  PwmLed,
} from './insights'
