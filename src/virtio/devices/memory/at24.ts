/** AT24-style I2C EEPROM declaration. */

import { createMemoryChip, type MemoryChip, type MemoryDecl } from './model'

export const at24Decl: MemoryDecl = {
  name: 'AT24C02 EEPROM',
  shellLabel: 'EEPROM_0',
  defaultAddress: 0x50,
  size: 256,
  addressWidth: 1,
  pageSize: 8,
}

export interface At24Options {
  address?: number
  size?: number
  name?: string
  persistKey?: string
}

export type At24Chip = MemoryChip

export function createAt24({ address, size, name, persistKey }: At24Options = {}): At24Chip {
  return createMemoryChip(at24Decl, { address, size, name, persistKey })
}
