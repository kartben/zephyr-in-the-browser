/**
 * An Analog Devices ADXL345 3-axis accelerometer, as a {@link SensorDecl}.
 *
 * The flagship "more than a slider" sensor: three channels instead of one, real
 * data registers a driver bursts across in one read, and a browser source (the
 * device's own tilt) it can follow. It is what pushed the framework to grow an
 * auto-increment read mode — a driver reads DATAX0..DATAZ1 (0x32..0x37) in a
 * single i2c_burst_read, so the read has to stream forward across registers.
 *
 * Register model, matching the datasheet and Zephyr's stock `adi,adxl345`:
 *
 * - DEVID (0x00) is a fixed 0xE5 the driver reads to confirm the part.
 * - POWER_CTL (0x2D) and DATA_FORMAT (0x31) are written by the driver at init;
 *   we store them so a read-back matches, but they do not change the encoding.
 * - Each axis is a 16-bit little-endian signed count at 0x32/0x34/0x36. The
 *   sensitivity is the ADXL345's fixed full-resolution 256 LSB/g.
 *
 * Caveat: the exact sensitivity/format is a driver contract, and this models the
 * canonical 256 LSB/g full-resolution behaviour. A rebuilt guest image is what
 * confirms `adi,adxl345` reads it as expected; the unit test here only pins the
 * page-side round trip.
 */

import adxl345Map from './maps/adxl345.json'
import { registersFromJson, type RegisterMapJson } from './registerMap'
import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_DATAX = 0x32
const REG_DATAY = 0x34
const REG_DATAZ = 0x36

/** Full-resolution sensitivity: 256 LSB per g. */
const LSB_PER_G = 256
const G = 9.80665

/** m/s² -> a signed 16-bit little-endian count, clamped to the 13-bit field. */
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
