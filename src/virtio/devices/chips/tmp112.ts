/**
 * A TI TMP112 temperature sensor, in the page.
 *
 * The point of this one is not the chip, it is the driver on the other side:
 * Zephyr's stock `ti,tmp112` binds to it unmodified, so the browser's
 * temperature slider ends up driving a real sensor driver over a real bus
 * rather than a bespoke MMIO device invented for the demo. Everything Zephyr's
 * sensor API can do — `sensor get`, fetch/channel_get, a sample loop — works
 * against a value the page made up.
 *
 * Register model, from the datasheet and matching what the driver expects:
 *
 * - Every write starts with a pointer byte. A write of *only* that byte just
 *   moves the pointer, which is how `i2c_burst_read` addresses a register;
 *   a write of three bytes also stores a big-endian 16-bit value.
 * - Reads return the 16-bit register at the pointer, big-endian.
 * - Temperature is left-justified: 12 bits normally, 13 in extended mode, with
 *   bit 0 of the low byte flagging which. The driver arithmetic-shifts by 4 or
 *   3 accordingly, so sign extension has to survive the round trip.
 *
 * One LSB is 0.0625 °C.
 */

import type { I2cChip } from '../i2c'

const REG_TEMPERATURE = 0x00
const REG_CONFIG = 0x01
const REG_TLOW = 0x02
const REG_THIGH = 0x03

/** Extended mode: 13-bit temperature, up to 150 °C. */
const CONFIG_EM = 1 << 4

/** Micro-degrees Celsius per LSB. */
const SCALE_C = 0.0625

export interface Tmp112Options {
  address?: number
  name?: string
  /** Initial reading, before anything sets one. */
  celsius?: number
}

export interface Tmp112Chip extends I2cChip {
  /** Drive the temperature the guest will read next. */
  setCelsius(celsius: number): void
  getCelsius(): number
}

export function createTmp112({
  address = 0x48,
  name = 'TMP112 temperature',
  celsius = 21,
}: Tmp112Options = {}): Tmp112Chip {
  let pointer = REG_TEMPERATURE
  let temperature = celsius
  /* What the driver writes at init; the EM bit is the part that matters here. */
  let config = 0x60a0
  let tLow = 0
  let tHigh = 0

  /** Encode °C into the register's left-justified, sign-extended form. */
  function encodeTemperature(): number {
    const extended = (config & CONFIG_EM) !== 0
    const shift = extended ? 3 : 4
    /*
     * Clamp in *counts*, not in degrees. The obvious reading of the datasheet
     * limits — "up to 128 °C" — is off by one LSB, and 128 °C is 2048 counts,
     * which does not fit the 12-bit signed field: left-justified it becomes
     * 0x8000, and the driver's arithmetic shift reads that back as -128 °C.
     * The real ceiling is 2047 counts, 127.9375 °C.
     */
    const min = -880 // -55 °C
    const max = extended ? 2400 : 2047 // 150 °C / 127.9375 °C
    const counts = Math.min(max, Math.max(min, Math.round(temperature / SCALE_C)))
    // Two's complement in 16 bits, then left-justified.
    return ((counts << shift) & 0xffff) | (extended ? 1 : 0)
  }

  function readRegister(): number {
    switch (pointer) {
      case REG_TEMPERATURE:
        return encodeTemperature()
      case REG_CONFIG:
        return config
      case REG_TLOW:
        return tLow
      case REG_THIGH:
        return tHigh
      default:
        return 0
    }
  }

  return {
    address,
    name,

    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0] & 0x03
      if (bytes.length < 3) {
        // Pointer-only write: the first half of a register read.
        return true
      }
      const value = ((bytes[1] << 8) | bytes[2]) & 0xffff
      switch (pointer) {
        case REG_CONFIG:
          config = value
          break
        case REG_TLOW:
          tLow = value
          break
        case REG_THIGH:
          tHigh = value
          break
        default:
          // The temperature register is read-only on the real part, and the
          // driver never writes it.
          break
      }
      return true
    },

    read(length) {
      const value = readRegister()
      const out = new Uint8Array(length)
      // Big-endian, and a read longer than two bytes repeats the register the
      // way the real part does rather than running off into other registers.
      for (let i = 0; i < length; i++) {
        out[i] = i % 2 === 0 ? (value >> 8) & 0xff : value & 0xff
      }
      return out
    },

    setCelsius(next) {
      if (Number.isFinite(next)) temperature = next
    },
    getCelsius: () => temperature,
  }
}
