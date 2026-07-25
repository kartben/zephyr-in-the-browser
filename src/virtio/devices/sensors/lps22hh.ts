/**
 * An STMicroelectronics LPS22HH pressure + temperature sensor, as a
 * {@link SensorDecl}.
 *
 * Bundles `samples/sensor/lps22hh`. Without an INT line the driver runs in
 * one-shot mode: each `sensor_sample_fetch` triggers a measurement and polls
 * STATUS until P_DA|T_DA. STATUS always reports ready here so that loop exits.
 *
 * Register model (datasheet + Zephyr/STMems):
 *
 * - WHO_AM_I (0x0F) = 0xB3.
 * - PRESS_OUT_XL (0x28) is a 24-bit little-endian left-aligned sample;
 *   sensitivity 4096 LSB/hPa, reported as kPa.
 * - TEMP_OUT_L (0x2B) is 16-bit LE at 100 LSB/°C.
 */

import { clampToUint, clampUint } from './helpers'
import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_WHO_AM_I = 0x0f
const REG_CTRL1 = 0x10
const REG_CTRL2 = 0x11
const REG_CTRL3 = 0x12
const REG_STATUS = 0x27
const REG_PRESS = 0x28
const REG_TEMP = 0x2b

const WHO_AM_I = 0xb3
/** STATUS: P_DA | T_DA — one-shot polling never waits on us. */
const STATUS_READY = 0x03

/** kPa → 24-bit PRESS_OUT count (4096 LSB/hPa ⇒ 40960 LSB/kPa). */
function encodePressure(kPa: number): number {
  return clampUint(kPa * 40960, 24)
}

/** °C → signed 16-bit at 100 LSB/°C. */
function encodeTemp(celsius: number): number {
  return clampToUint(celsius * 100)
}

export const lps22hhDecl: SensorDecl = {
  name: 'LPS22HH pressure',
  shellLabel: 'lps22hh',
  // SA0 low — clear of the IMU at 0x6a and the ADXL at 0x53.
  defaultAddress: 0x5c,
  autoIncrement: true,
  registers: [
    { addr: REG_WHO_AM_I, bytes: 1, access: 'ro', reset: WHO_AM_I },
    { addr: REG_CTRL1, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL2, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_CTRL3, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_STATUS, bytes: 1, access: 'ro', reset: STATUS_READY },
    { addr: REG_PRESS, bytes: 3, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_TEMP, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
  ],
  channels: [
    {
      key: 'pressure',
      label: 'Pressure',
      zephyr: 'press',
      unit: 'kPa',
      min: 30,
      max: 125,
      step: 0.1,
      initial: 101.325,
      reg: REG_PRESS,
      encode: encodePressure,
    },
    {
      key: 'temp',
      label: 'Temperature',
      zephyr: 'ambient_temp',
      unit: '°C',
      min: -40,
      max: 85,
      step: 0.1,
      initial: 21,
      reg: REG_TEMP,
      encode: encodeTemp,
    },
  ],
}

export interface Lps22hhOptions {
  address?: number
  name?: string
}

export function createLps22hh({ address, name }: Lps22hhOptions = {}): SensorChip {
  return createSensorChip(lps22hhDecl, { address, name })
}
