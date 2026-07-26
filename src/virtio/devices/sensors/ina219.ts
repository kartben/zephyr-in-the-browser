/**
 * INA219 current/power monitor. Registers are 16-bit big-endian; current and
 * power encode with the sample overlay's `lsb-microamp = <10>`. V_BUS always
 * sets CNVR so Zephyr's conversion-ready poll returns immediately.
 */

import { clampToUint, clampUint } from './helpers'
import { createSensorChip, type SensorChip, type SensorDecl } from './model'

const REG_CONF = 0x00
const REG_V_SHUNT = 0x01
const REG_V_BUS = 0x02
const REG_POWER = 0x03
const REG_CURRENT = 0x04
const REG_CALIB = 0x05

const CURRENT_LSB_UA = 10
const V_BUS_MUL = 0.004
const SI_MUL = 0.00001
const POWER_MUL = 20
const CNVR = 1 << 1

function encodeBusVoltage(volts: number): number {
  const counts = clampUint(volts / V_BUS_MUL, 16) & 0x3fff
  return ((counts << 3) | CNVR) & 0xffff
}

function encodeCurrent(amps: number): number {
  // channel_get: amps = counts * current_lsb * SI_MUL
  return clampToUint(amps / (CURRENT_LSB_UA * SI_MUL))
}

function encodePower(watts: number): number {
  // channel_get: watts = counts * current_lsb * POWER_MUL * SI_MUL
  return clampUint(watts / (CURRENT_LSB_UA * POWER_MUL * SI_MUL))
}

export const ina219Decl: SensorDecl = {
  name: 'INA219 power monitor',
  shellLabel: 'ina219',
  defaultAddress: 0x40,
  registers: [
    { addr: REG_CONF, bytes: 2, access: 'rw', reset: 0x399f, endian: 'be' },
    { addr: REG_V_SHUNT, bytes: 2, access: 'ro', reset: 0, endian: 'be' },
    { addr: REG_V_BUS, bytes: 2, access: 'ro', reset: CNVR, endian: 'be' },
    { addr: REG_POWER, bytes: 2, access: 'ro', reset: 0, endian: 'be' },
    { addr: REG_CURRENT, bytes: 2, access: 'ro', reset: 0, endian: 'be' },
    { addr: REG_CALIB, bytes: 2, access: 'rw', reset: 0, endian: 'be' },
  ],
  channels: [
    {
      key: 'voltage',
      label: 'Bus voltage',
      zephyr: 'voltage',
      unit: 'V',
      min: 0,
      max: 26,
      step: 0.01,
      initial: 3.3,
      reg: REG_V_BUS,
      encode: encodeBusVoltage,
    },
    {
      key: 'current',
      label: 'Current',
      zephyr: 'current',
      unit: 'A',
      min: -3,
      max: 3,
      step: 0.001,
      initial: 0.15,
      reg: REG_CURRENT,
      encode: encodeCurrent,
    },
    {
      key: 'power',
      label: 'Power',
      zephyr: 'power',
      unit: 'W',
      min: 0,
      max: 10,
      step: 0.01,
      initial: 0.5,
      reg: REG_POWER,
      encode: encodePower,
    },
  ],
}

export interface Ina219Options {
  address?: number
  name?: string
}

export function createIna219({ address, name }: Ina219Options = {}): SensorChip {
  return createSensorChip(ina219Decl, { address, name })
}
