/**
 * ISL29035 light sensor. DATA_MSB is a high-byte mirror of DATA_LSB's 16-bit
 * little-endian channel word; lux encoding follows COMMAND_II's range bits.
 */

import { clampUint } from './helpers'
import { createSensorChip, type CodecCtx, type SensorChip, type SensorDecl } from './model'

const REG_COMMAND_I = 0x00
const REG_COMMAND_II = 0x01
const REG_DATA_LSB = 0x02
const REG_DATA_MSB = 0x03
const REG_INT_LT_LSB = 0x04
const REG_INT_HT_LSB = 0x06
const REG_ID = 0x0f

const LUX_RANGES = [1000, 4000, 16000, 64000] as const
const ADC_BITS = 16
const ADC_MAX = 1 << ADC_BITS

function encodeLux(lux: number, ctx: CodecCtx): number {
  const range = LUX_RANGES[ctx.reg(REG_COMMAND_II) & 0x03] ?? 4000
  return clampUint((lux * ADC_MAX) / range)
}

export const isl29035Decl: SensorDecl = {
  name: 'ISL29035 light',
  shellLabel: 'isl29035',
  defaultAddress: 0x44,
  registers: [
    { addr: REG_COMMAND_I, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_COMMAND_II, bytes: 1, access: 'rw', reset: 0 },
    // Channel word lives at LSB as a 16-bit LE value; a 1-byte read returns
    // the low byte. MSB is the high byte of the same encode via highByteOf.
    { addr: REG_DATA_LSB, bytes: 2, access: 'ro', reset: 0, endian: 'le' },
    { addr: REG_DATA_MSB, bytes: 1, access: 'ro', reset: 0, highByteOf: REG_DATA_LSB },
    { addr: REG_INT_LT_LSB, bytes: 1, access: 'rw', reset: 0 },
    { addr: REG_INT_HT_LSB, bytes: 1, access: 'rw', reset: 0 },
    // ID register: bits [4:3] identify the part; leave zeroed — the driver
    // does not probe it at init.
    { addr: REG_ID, bytes: 1, access: 'ro', reset: 0 },
  ],
  channels: [
    {
      key: 'light',
      label: 'Ambient light',
      zephyr: 'light',
      unit: 'lux',
      min: 0,
      max: 4000,
      step: 1,
      initial: 320,
      reg: REG_DATA_LSB,
      // Encode returns a 16-bit word; the LSB reg emits the low byte, and the
      // MSB reg's highByteOf pulls the high byte of the same encode.
      encode: encodeLux,
    },
  ],
  attributes: [
    {
      key: 'lux_range',
      label: 'Lux range',
      reg: REG_COMMAND_II,
      bits: {
        shift: 0,
        width: 2,
        options: [
          { label: '1000', value: 0 },
          { label: '4000', value: 1 },
          { label: '16000', value: 2 },
          { label: '64000', value: 3 },
        ],
      },
    },
  ],
}

export interface Isl29035Options {
  address?: number
  name?: string
}

export function createIsl29035({ address, name }: Isl29035Options = {}): SensorChip {
  const chip = createSensorChip(isl29035Decl, { address, name })
  // Match the sample's 4K range so the panel select starts where the driver puts it.
  chip.setAttr('lux_range', 1)
  return chip
}
