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
 * - POWER_CTL (0x2D) is stored so a read-back matches.
 * - DATA_FORMAT (0x31) sets the encoding, as on the part. The driver writes its
 *   devicetree `range` there at init (default ±8 g) and leaves FULL_RES clear,
 *   then decodes at that range's 10-bit scale: 64 LSB/g at ±8 g. FULL_RES
 *   would keep 256 LSB/g at any range and widen the field instead.
 * - Each axis is a 16-bit little-endian signed count at 0x32/0x34/0x36,
 *   right-justified and sign-extended, saturating at the end of the range.
 */

import adxl345Map from './maps/adxl345.json'
import { registersFromJson, type RegisterMapJson } from '../registers'
import { STANDARD_GRAVITY as G } from './helpers'
import { createSensorChip, type CodecCtx, type SensorChip, type SensorDecl } from './model'

const REG_DATA_FORMAT = 0x31
const REG_DATAX = 0x32
const REG_DATAY = 0x34
const REG_DATAZ = 0x36

const FULL_RES = 1 << 3
/** Sensitivity at ±2 g, and in full-resolution mode at any range. */
const LSB_PER_G = 256

/**
 * m/s² -> the signed count DATA_FORMAT asks for. 10-bit mode scales with the
 * range (256 LSB/g at ±2 g down to 32 at ±16 g) and holds -512..511;
 * FULL_RES keeps 256 LSB/g and grows the field by a bit per range step.
 */
function encodeAxis(ms2: number, ctx: CodecCtx): number {
  const format = ctx.reg(REG_DATA_FORMAT)
  const range = format & 0x03
  const fullRes = (format & FULL_RES) !== 0
  const lsbPerG = fullRes ? LSB_PER_G : LSB_PER_G >> range
  const limit = fullRes ? 512 << range : 512
  const counts = Math.min(limit - 1, Math.max(-limit, Math.round((ms2 / G) * lsbPerG)))
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
