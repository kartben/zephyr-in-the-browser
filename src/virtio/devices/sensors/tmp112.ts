/**
 * A TI TMP112 temperature sensor, expressed as a {@link SensorDecl}.
 *
 * This is the same part that used to be hand-written in
 * src/virtio/devices/chips/tmp112.ts; it now rides the generic register machine
 * in ./model.ts, and the TMP112 suite in src/virtio/i2c.test.ts is what proves
 * the two are byte-for-byte identical. The interesting behaviour — the whole
 * reason to model a real part rather than invent an MMIO device — is that
 * Zephyr's stock `ti,tmp112` binds to it unmodified.
 *
 * The register file (names, bitfields, reset values) lives in
 * {@link ./maps/tmp112.json} — an SVD-inspired JSON map. Channel codecs stay
 * here because they are functions.
 *
 * Register model, from the datasheet and matching what the driver expects:
 *
 * - Every write starts with a pointer byte (masked to the low two bits). A
 *   write of only that byte moves the pointer, which is how `i2c_burst_read`
 *   addresses a register; a three-byte write also stores a big-endian word.
 * - Reads return the 16-bit register at the pointer, big-endian.
 * - Temperature is left-justified: 12 bits normally, 13 in extended mode, with
 *   bit 0 of the low byte flagging which. The driver arithmetic-shifts by 4 or
 *   3 accordingly, so sign extension has to survive the round trip.
 *
 * One LSB is 0.0625 °C.
 */

import tmp112Map from './maps/tmp112.json'
import { registersFromJson, type RegisterMapJson } from '../registers'
import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_TEMPERATURE = 0x00
const REG_CONFIG = 0x01

/** Extended mode: 13-bit temperature, up to 150 °C. */
const CONFIG_EM = 1 << 4

/** °C per LSB. */
const SCALE_C = 0.0625

/** Encode °C into the register's left-justified, sign-extended form. */
function encodeTemperature(celsius: number, config: number): number {
  const extended = (config & CONFIG_EM) !== 0
  const shift = extended ? 3 : 4
  /*
   * Clamp in *counts*, not in degrees. The obvious reading of the datasheet
   * limits — "up to 128 °C" — is off by one LSB, and 128 °C is 2048 counts,
   * which does not fit the 12-bit signed field: left-justified it becomes
   * 0x8000, and the driver's arithmetic shift reads that back as -128 °C. The
   * real ceiling is 2047 counts, 127.9375 °C.
   */
  const min = -880 // -55 °C
  const max = extended ? 2400 : 2047 // 150 °C / 127.9375 °C
  const counts = Math.min(max, Math.max(min, Math.round(celsius / SCALE_C)))
  // Two's complement in 16 bits, then left-justified, with the EM flag in bit 0.
  return ((counts << shift) & 0xffff) | (extended ? 1 : 0)
}

/** The declarative TMP112, reusable by the bus roster's attach picker. */
export const tmp112Decl: SensorDecl = {
  name: 'TMP112 temperature',
  shellLabel: 'tmp112',
  defaultAddress: 0x48,
  // The pointer register is two bits wide on this part.
  pointerMask: 0x03,
  registers: registersFromJson(tmp112Map as RegisterMapJson),
  channels: [
    {
      key: 'temp',
      label: 'Temperature',
      zephyr: 'ambient_temp',
      unit: '°C',
      min: -40,
      max: 125,
      step: 0.5,
      initial: 21,
      reg: REG_TEMPERATURE,
      encode: (celsius, ctx) => encodeTemperature(celsius, ctx.reg(REG_CONFIG)),
    },
  ],
  attributes: [
    { key: 'extended', label: 'Extended mode (13-bit)', reg: REG_CONFIG, bit: 4 },
    { key: 'shutdown', label: 'Shutdown', reg: REG_CONFIG, bit: 8 },
  ],
}

export interface Tmp112Options {
  address?: number
  name?: string
  /** Initial reading, before anything sets one. */
  celsius?: number
}

/**
 * The TMP112 as an I2cChip, with the same `setCelsius`/`getCelsius` surface the
 * hand-written part had so existing callers (and the temperature-slider wiring
 * in src/virtio/index.ts) keep working unchanged.
 */
export interface Tmp112Chip extends SensorChip {
  setCelsius(celsius: number): void
  getCelsius(): number
}

export function createTmp112({ address, name, celsius }: Tmp112Options = {}): Tmp112Chip {
  const chip = createSensorChip(tmp112Decl, { address, name })
  if (celsius !== undefined) chip.setChannel('temp', celsius)
  return Object.assign(chip, {
    setCelsius: (next: number) => chip.setChannel('temp', next),
    getCelsius: () => chip.getChannel('temp'),
  })
}
