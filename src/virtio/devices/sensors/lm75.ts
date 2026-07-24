/**
 * An LM75-style I2C temperature sensor, as a {@link SensorDecl}.
 *
 * The simplest sensor worth modelling, and the clearest proof that the register
 * framework generalizes past the TMP112 it was extracted from: an LM75 is a
 * TMP112 with less to it. Same pointer machine, same left-justified temperature
 * register — just a fixed 9-bit resolution and no extended mode.
 *
 * Register model, matching the classic National/TI LM75 and Zephyr's stock
 * `lm75` driver:
 *
 * - Register pointer selects one of four registers (temp, config, Thyst, Tos).
 * - Temperature is a 16-bit big-endian word, 9-bit two's-complement in the top
 *   bits (D15..D7), the low 7 bits zero. One LSB is 0.5 °C. The driver reads it
 *   as int16 and arithmetic-shifts right by 7, so sign extension has to survive.
 * - Config is a single byte; Thyst/Tos are left-justified like the temperature.
 *
 * Note: exact resolution/shift is a driver detail. This models the canonical
 * 9-bit part; a rebuilt guest image is what confirms the `lm75` driver decodes
 * it as expected (see the LM75 unit test for the page-side round trip).
 */

import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_TEMP = 0x00
const REG_CONFIG = 0x01
const REG_THYST = 0x02
const REG_TOS = 0x03

/** 9-bit two's-complement, left-justified by 7. One LSB is 0.5 °C. */
const SCALE_C = 0.5
const SHIFT = 7

function encodeTemperature(celsius: number): number {
  // Clamp in counts: 9-bit signed is [-256, 255], i.e. -128 °C .. +127.5 °C.
  const counts = Math.min(255, Math.max(-256, Math.round(celsius / SCALE_C)))
  return (counts << SHIFT) & 0xffff
}

export const lm75Decl: SensorDecl = {
  name: 'LM75 temperature',
  shellLabel: 'lm75',
  // 0x48 is the TMP112's strap; the LM75 sits one along so both can share the bus.
  defaultAddress: 0x49,
  pointerMask: 0x03,
  registers: [
    { addr: REG_TEMP, bytes: 2, access: 'ro', reset: 0 },
    { addr: REG_CONFIG, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_THYST, bytes: 2, access: 'rw', reset: encodeTemperature(75) },
    { addr: REG_TOS, bytes: 2, access: 'rw', reset: encodeTemperature(80) },
  ],
  channels: [
    {
      key: 'temp',
      label: 'Temperature',
      zephyr: 'ambient_temp',
      unit: '°C',
      min: -55,
      max: 125,
      step: 0.5,
      initial: 22,
      reg: REG_TEMP,
      encode: (celsius) => encodeTemperature(celsius),
    },
  ],
  attributes: [{ key: 'shutdown', label: 'Shutdown', reg: REG_CONFIG, bit: 0 }],
}

export interface Lm75Options {
  address?: number
  name?: string
  celsius?: number
}

export function createLm75({ address, name, celsius }: Lm75Options = {}): SensorChip {
  const chip = createSensorChip(lm75Decl, { address, name })
  if (celsius !== undefined) chip.setChannel('temp', celsius)
  return chip
}
