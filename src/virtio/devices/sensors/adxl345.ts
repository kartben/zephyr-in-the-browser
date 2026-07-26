/** ADXL345 3-axis accelerometer as a SensorDecl. */

import adxl345Map from './maps/adxl345.json'
import { registersFromJson, type RegisterMapJson } from './registerMap'
import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_DATAX = 0x32
const REG_DATAY = 0x34
const REG_DATAZ = 0x36

const LSB_PER_G = 256
const G = 9.80665

/** Full-resolution mode is 256 LSB/g, clamped to the 13-bit field. */
function encodeAxis(ms2: number): number {
  const counts = Math.min(4095, Math.max(-4096, Math.round((ms2 / G) * LSB_PER_G)))
  return counts & 0xffff
}

function axis(key: string, label: string, zephyr: string, reg: number, source: SensorDecl['channels'][number]['source']) {
  return {
    key,
    label,
    zephyr,
    unit: 'm/s²',
    min: -20,
    max: 20,
    step: 0.1,
    reg,
    encode: encodeAxis,
    source,
  } as const
}

export const adxl345Decl: SensorDecl = {
  name: 'ADXL345 accelerometer',
  shellLabel: 'adxl345',
  // 0x53 with the ALT ADDRESS pin low — the common strap, and clear of the
  // EEPROM at 0x50 and the temperature parts at 0x48/0x49.
  defaultAddress: 0x53,
  autoIncrement: true,
  registers: registersFromJson(adxl345Map as RegisterMapJson),
  channels: [
    { ...axis('accel_x', 'Accel X', 'accel_x', REG_DATAX, 'orientation-x'), initial: 0 },
    { ...axis('accel_y', 'Accel Y', 'accel_y', REG_DATAY, 'orientation-y'), initial: 0 },
    // At rest, gravity is on Z — a sane default before the user tilts anything.
    { ...axis('accel_z', 'Accel Z', 'accel_z', REG_DATAZ, 'orientation-z'), initial: G },
  ],
}

export interface Adxl345Options {
  address?: number
  name?: string
}

export function createAdxl345({ address, name }: Adxl345Options = {}): SensorChip {
  return createSensorChip(adxl345Decl, { address, name })
}
