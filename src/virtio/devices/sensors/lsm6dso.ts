/**
 * An STMicroelectronics LSM6DSO 6-axis IMU, as a {@link SensorDecl}.
 *
 * The "advanced" counterpart to the ADXL345: accel *and* gyro, and the guest
 * configures sampling rate through Zephyr's sensor attribute API
 * (`SENSOR_ATTR_SAMPLING_FREQUENCY`), which the stock `st,lsm6dso` driver turns
 * into writes to CTRL1_XL / CTRL2_G. The ODR fields are exposed as panel
 * attributes so you can watch the sample's `sensor_attr_set(..., 12.5 Hz)` land
 * on the chip — the whole point of bundling `samples/sensor/lsm6dso`.
 *
 * Register model, matching the datasheet and Zephyr's driver + STMems HAL:
 *
 * - WHO_AM_I (0x0F) is the fixed 0x6C the driver probes at init.
 * - CTRL1_XL (0x10) / CTRL2_G (0x11) hold ODR[7:4] and full-scale[3:2]; the
 *   driver writes them at init and again from `sensor_attr_set`.
 * - CTRL3_C..CTRL10_C and the FIFO/INT block are stored so init's soft-reset,
 *   BDU, I3C-disable and FIFO-bypass writes read back cleanly.
 * - Gyro OUTX_L_G..OUTZ_H_G (0x22..0x27) and accel OUTX_L_A..OUTZ_H_A
 *   (0x28..0x2D) are little-endian signed counts; a driver bursts six bytes
 *   from each base, so auto-increment is on.
 *
 * Sensitivity follows the driver's GAIN_UNIT_XL (61 µg/LSB) and GAIN_UNIT_G
 * (4.375 mdps/LSB) tables, keyed off the FS bits the guest last wrote.
 */

import { createSensorChip, type CodecCtx, type SensorChip, type SensorDecl } from './model'

const REG_FUNC_CFG_ACCESS = 0x01
const REG_FIFO_CTRL1 = 0x07
const REG_FIFO_CTRL2 = 0x08
const REG_FIFO_CTRL3 = 0x09
const REG_FIFO_CTRL4 = 0x0a
const REG_INT1_CTRL = 0x0d
const REG_INT2_CTRL = 0x0e
const REG_WHO_AM_I = 0x0f
const REG_CTRL1_XL = 0x10
const REG_CTRL2_G = 0x11
const REG_CTRL3_C = 0x12
const REG_CTRL4_C = 0x13
const REG_CTRL5_C = 0x14
const REG_CTRL6_C = 0x15
const REG_CTRL7_G = 0x16
const REG_CTRL8_XL = 0x17
const REG_CTRL9_XL = 0x18
const REG_CTRL10_C = 0x19
const REG_STATUS = 0x1e
const REG_OUTX_G = 0x22
const REG_OUTY_G = 0x24
const REG_OUTZ_G = 0x26
const REG_OUTX_A = 0x28
const REG_OUTY_A = 0x2a
const REG_OUTZ_A = 0x2c

const WHO_AM_I = 0x6c
/** CTRL3_C after reset: IF_INC=1, so burst reads auto-increment. */
const CTRL3_C_RESET = 0x04
/** STATUS_REG: XLDA | GDA always ready — polling never waits on us. */
const STATUS_READY = 0x03

const G = 9.80665
/** Zephyr GAIN_UNIT_XL — µg per LSB at ±2 g, then scaled by FS. */
const GAIN_UNIT_XL = 61
/** Zephyr GAIN_UNIT_G — µdps per LSB grain; FS multiplies it. */
const GAIN_UNIT_G = 4375

/** Accel FS field (CTRL1_XL[3:2]) → sensitivity in µg/LSB, matching the driver. */
const ACCEL_UG_PER_LSB = [61, 488, 122, 244] as const
/** Gyro FS decode → sensitivity multiplier of GAIN_UNIT_G (250/125/500/1000/2000). */
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

/** m/s² → signed 16-bit count at the FS currently in CTRL1_XL. */
function encodeAccel(ms2: number, ctx: CodecCtx): number {
  const fs = (ctx.reg(REG_CTRL1_XL) >> 2) & 0x03
  const ugPerLsb = ACCEL_UG_PER_LSB[fs] ?? GAIN_UNIT_XL
  const counts = Math.round(ms2 / (ugPerLsb * G * 1e-6))
  return Math.min(32767, Math.max(-32768, counts)) & 0xffff
}

/**
 * rad/s → signed 16-bit count at the FS currently in CTRL2_G.
 *
 * Inverts the driver's path: raw * (sens * GAIN_UNIT_G) / 10 → 10 µdeg/s → rad/s.
 */
function encodeGyro(radPerSec: number, ctx: CodecCtx): number {
  const sensitivity = gyroSensMultiplier(ctx.reg(REG_CTRL2_G)) * GAIN_UNIT_G
  const counts = Math.round((radPerSec * 1.8e8) / (Math.PI * sensitivity))
  return Math.min(32767, Math.max(-32768, counts)) & 0xffff
}

/** ODR_XL / ODR_G nibble — same map the Zephyr driver uses for attr_set. */
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
  registers: [
    { addr: REG_FUNC_CFG_ACCESS, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_FIFO_CTRL1, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_FIFO_CTRL2, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_FIFO_CTRL3, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_FIFO_CTRL4, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_INT1_CTRL, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_INT2_CTRL, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_WHO_AM_I, bytes: 1, access: 'ro', reset: WHO_AM_I },
    { addr: REG_CTRL1_XL, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL2_G, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL3_C, bytes: 1, access: 'rw', reset: CTRL3_C_RESET },
    { addr: REG_CTRL4_C, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL5_C, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL6_C, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL7_G, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL8_XL, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL9_XL, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL10_C, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_STATUS, bytes: 1, access: 'ro', reset: STATUS_READY },
    { addr: REG_OUTX_G, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_OUTY_G, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_OUTZ_G, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_OUTX_A, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_OUTY_A, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_OUTZ_A, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
  ],
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
