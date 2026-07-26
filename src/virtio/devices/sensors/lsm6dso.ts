/**
 * LSM6DSO IMU register model. Accel/gyro outputs are little-endian signed
 * counts with auto-increment; sensitivity follows the FS bits in CTRL1_XL and
 * CTRL2_G using Zephyr's GAIN_UNIT_XL / GAIN_UNIT_G tables.
 */

import lsm6dsoMap from './maps/lsm6dso.json'
import { registersFromJson, type RegisterMapJson } from './registerMap'
import { createSensorChip, type CodecCtx, type SensorChip, type SensorDecl } from './model'

const REG_CTRL1_XL = 0x10
const REG_CTRL2_G = 0x11
const REG_OUTX_G = 0x22
const REG_OUTY_G = 0x24
const REG_OUTZ_G = 0x26
const REG_OUTX_A = 0x28
const REG_OUTY_A = 0x2a
const REG_OUTZ_A = 0x2c

const G = 9.80665
const GAIN_UNIT_XL = 61
const GAIN_UNIT_G = 4375

const ACCEL_UG_PER_LSB = [61, 488, 122, 244] as const
function gyroSensMultiplier(ctrl2: number): number {
  const fs125 = (ctrl2 & 0x02) !== 0
  const fsG = (ctrl2 >> 2) & 0x03
  if (fs125 && fsG === 0) return 1 // ±125 dps
  switch (fsG) {
    case 0:
      return 2 // ±250
    case 1:
      return 4 // ±500
    case 2:
      return 8 // ±1000
    default:
      return 16 // ±2000
  }
}

function encodeAccel(ms2: number, ctx: CodecCtx): number {
  const fs = (ctx.reg(REG_CTRL1_XL) >> 2) & 0x03
  const ugPerLsb = ACCEL_UG_PER_LSB[fs] ?? GAIN_UNIT_XL
  const counts = Math.round(ms2 / (ugPerLsb * G * 1e-6))
  return Math.min(32767, Math.max(-32768, counts)) & 0xffff
}

/** Inverts the driver's raw-to-rad/s path for the FS currently in CTRL2_G. */
function encodeGyro(radPerSec: number, ctx: CodecCtx): number {
  const sensitivity = gyroSensMultiplier(ctx.reg(REG_CTRL2_G)) * GAIN_UNIT_G
  const counts = Math.round((radPerSec * 1.8e8) / (Math.PI * sensitivity))
  return Math.min(32767, Math.max(-32768, counts)) & 0xffff
}

const ODR_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '12.5 Hz', value: 1 },
  { label: '26 Hz', value: 2 },
  { label: '52 Hz', value: 3 },
  { label: '104 Hz', value: 4 },
  { label: '208 Hz', value: 5 },
  { label: '417 Hz', value: 6 },
  { label: '833 Hz', value: 7 },
  { label: '1667 Hz', value: 8 },
  { label: '3333 Hz', value: 9 },
  { label: '6667 Hz', value: 10 },
]

const ACCEL_FS_OPTIONS = [
  { label: '±2 g', value: 0 },
  { label: '±16 g', value: 1 },
  { label: '±4 g', value: 2 },
  { label: '±8 g', value: 3 },
]

const GYRO_FS_OPTIONS = [
  { label: '±250 dps', value: 0 },
  { label: '±500 dps', value: 1 },
  { label: '±1000 dps', value: 2 },
  { label: '±2000 dps', value: 3 },
]

function accelAxis(
  key: string,
  label: string,
  zephyr: string,
  reg: number,
  source: SensorDecl['channels'][number]['source'],
  initial: number,
) {
  return {
    key,
    label,
    zephyr,
    unit: 'm/s²',
    min: -20,
    max: 20,
    step: 0.1,
    reg,
    encode: encodeAccel,
    source,
    initial,
  } as const
}

function gyroAxis(key: string, label: string, zephyr: string, reg: number) {
  return {
    key,
    label,
    zephyr,
    unit: 'rad/s',
    min: -10,
    max: 10,
    step: 0.01,
    reg,
    encode: encodeGyro,
    initial: 0,
  } as const
}

export const lsm6dsoDecl: SensorDecl = {
  name: 'LSM6DSO IMU',
  shellLabel: 'lsm6dso',
  // SA0 low — the common strap, and clear of the ADXL at 0x53 / temps at 0x48/49.
  defaultAddress: 0x6a,
  autoIncrement: true,
  registers: registersFromJson(lsm6dsoMap as RegisterMapJson),
  channels: [
    accelAxis('accel_x', 'Accel X', 'accel_x', REG_OUTX_A, 'orientation-x', 0),
    accelAxis('accel_y', 'Accel Y', 'accel_y', REG_OUTY_A, 'orientation-y', 0),
    accelAxis('accel_z', 'Accel Z', 'accel_z', REG_OUTZ_A, 'orientation-z', G),
    gyroAxis('gyro_x', 'Gyro X', 'gyro_x', REG_OUTX_G),
    gyroAxis('gyro_y', 'Gyro Y', 'gyro_y', REG_OUTY_G),
    gyroAxis('gyro_z', 'Gyro Z', 'gyro_z', REG_OUTZ_G),
  ],
  attributes: [
    {
      key: 'accel_odr',
      label: 'Accel ODR',
      reg: REG_CTRL1_XL,
      bits: { shift: 4, width: 4, options: ODR_OPTIONS },
    },
    {
      key: 'gyro_odr',
      label: 'Gyro ODR',
      reg: REG_CTRL2_G,
      bits: { shift: 4, width: 4, options: ODR_OPTIONS },
    },
    {
      key: 'accel_fs',
      label: 'Accel full-scale',
      reg: REG_CTRL1_XL,
      bits: { shift: 2, width: 2, options: ACCEL_FS_OPTIONS },
    },
    {
      key: 'gyro_fs',
      label: 'Gyro full-scale',
      reg: REG_CTRL2_G,
      bits: { shift: 2, width: 2, options: GYRO_FS_OPTIONS },
    },
  ],
}

export interface Lsm6dsoOptions {
  address?: number
  name?: string
}

export function createLsm6dso({ address, name }: Lsm6dsoOptions = {}): SensorChip {
  return createSensorChip(lsm6dsoDecl, { address, name })
}
