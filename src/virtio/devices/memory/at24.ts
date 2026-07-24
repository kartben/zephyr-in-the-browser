/**
 * An AT24-style I2C EEPROM, as a {@link MemoryDecl}.
 *
 * The simplest chip worth modelling, and a genuine test of the bus in both
 * directions: a write carries a word address and then data, a read streams from
 * an internal pointer that auto-increments. That makes `i2c read` in the Zephyr
 * shell — which writes the register address and then reads — exercise a write
 * chain and a read chain of one transfer.
 *
 * It is also the part that earns the memory framework: everything above is
 * geometry plus a pointer, so the chip is now four declared numbers and the
 * machine in ./model.ts. Its card renders the same backing store as a hex dump,
 * which is the whole of what an EEPROM has to show.
 */

import { createMemoryChip, type MemoryChip, type MemoryDecl } from './model'

/** The AT24C02: 256 bytes, one-byte word addressing, 8-byte pages. */
export const at24Decl: MemoryDecl = {
  name: 'AT24C02 EEPROM',
  // The device name Zephyr's EEPROM shell uses for the first eeprom node.
  shellLabel: 'EEPROM_0',
  // The AT24 family straps 0x50-0x57.
  defaultAddress: 0x50,
  size: 256,
  addressWidth: 1,
  pageSize: 8,
}

export interface At24Options {
  /** 7-bit address. The AT24 family straps 0x50-0x57. */
  address?: number
  /** Size in bytes. 256 is an AT24C02, the one-byte-addressing part. */
  size?: number
  name?: string
}

export type At24Chip = MemoryChip

export function createAt24({ address, size, name }: At24Options = {}): At24Chip {
  return createMemoryChip(at24Decl, { address, size, name })
}
