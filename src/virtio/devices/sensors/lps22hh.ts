/**
 * LPS22HH pressure/temperature sensor. STATUS is always P_DA|T_DA for Zephyr's
 * one-shot poll; pressure is 24-bit little-endian at 4096 LSB/hPa.
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
const STATUS_READY = 0x03

function encodePressure(kPa: number): number {
  return clampUint(kPa * 40960, 24)
}

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
