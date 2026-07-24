/**
 * An AT24-style I2C EEPROM, in the page.
 *
 * The simplest chip worth modelling, and a genuine test of the bus in both
 * directions: a write carries a word address and then data, a read streams
 * from an internal pointer that auto-increments. That makes `i2c read` in the
 * Zephyr shell — which writes the register address and then reads — exercise a
 * write chain and a read chain of one transfer.
 *
 * Deliberately not modelling write cycle time. A real AT24 NAKs for a few
 * milliseconds after a write while the page programs, and drivers poll for
 * that; here the write lands immediately, so a driver that polls simply
 * succeeds on its first try.
 */

import type { I2cChip } from '../i2c'

export interface At24Options {
  /** 7-bit address. The AT24 family straps 0x50-0x57. */
  address?: number
  /** Size in bytes. 256 is an AT24C02, the one-byte-addressing part. */
  size?: number
  name?: string
}

export interface At24Chip extends I2cChip {
  /** The backing store, for a panel or a test to inspect. */
  readonly memory: Uint8Array
}

export function createAt24({
  address = 0x50,
  size = 256,
  name = 'AT24C02 EEPROM',
}: At24Options = {}): At24Chip {
  // Erased flash reads as 0xff, and so does an open bus — which means a driver
  // that finds 0xff everywhere cannot tell a blank part from a missing one.
  // That is true of the real chip too.
  const memory = new Uint8Array(size).fill(0xff)
  let pointer = 0

  return {
    address,
    name,
    memory,

    write(bytes) {
      if (bytes.length === 0) {
        // A zero-length write is how some drivers probe for the chip.
        return true
      }
      // First byte is always the word address; anything after it is data
      // written from there, wrapping at the end of the device.
      pointer = bytes[0] % size
      for (let i = 1; i < bytes.length; i++) {
        memory[pointer] = bytes[i]
        pointer = (pointer + 1) % size
      }
      return true
    },

    read(length) {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = memory[pointer]
        pointer = (pointer + 1) % size
      }
      return out
    },
  }
}
