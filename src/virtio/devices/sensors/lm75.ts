/**
 * LM75-style temperature sensor. Temperature registers are 16-bit big-endian,
 * 9-bit two's-complement left-justified by 7, matching Zephyr's arithmetic
 * right-shift decode.
 */

import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_TEMP = 0x00
const REG_CONFIG = 0x01
const REG_THYST = 0x02
const REG_TOS = 0x03

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
    {
      name: 'Temperature',
      addr: REG_TEMP,
      bytes: 2,
      access: 'ro',
      reset: 0,
      description: '9-bit two\'s-complement temperature, left-justified by 7.',
      fields: [
        { name: 'TEMP', lsb: 7, msb: 15, description: 'Temperature counts (0.5 °C/LSB).' },
      ],
    },
    {
      name: 'Configuration',
      addr: REG_CONFIG,
      bytes: 1,
      access: 'rw',
      reset: 0,
      fields: [
        {
          name: 'SD',
          lsb: 0,
          msb: 0,
          description: 'Shutdown.',
          values: [
            { name: 'Continuous', value: 0 },
            { name: 'Shutdown', value: 1 },
          ],
        },
      ],
    },
    {
      name: 'Thyst',
      addr: REG_THYST,
      bytes: 2,
      access: 'rw',
      reset: encodeTemperature(75),
      description: 'Hysteresis limit.',
    },
    {
      name: 'Tos',
      addr: REG_TOS,
      bytes: 2,
      access: 'rw',
      reset: encodeTemperature(80),
      description: 'Overtemperature shutdown limit.',
    },
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
