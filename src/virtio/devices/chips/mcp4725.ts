/**
 * Microchip MCP4725 12-bit DAC — page-side I²C model.
 *
 * First {@link DacChip} provider. Matches Zephyr's `drivers/dac/dac_mcp4725.c`:
 * fast-write 2-byte frames, RDY status on read. Stock `samples/drivers/dac`
 * drives a sawtooth through `dac_write_value`.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import {
  createDacHistory,
  dacCodeToVolts,
  type DacChannel,
  type DacChip,
  type DacDecl,
} from '../dac/model'
import mcp4725Map from './maps/mcp4725.json'

const ADDR_DAC_CODE = 0x00
const ADDR_STATUS = 0x01
const ADDR_EEPROM = 0x02
const RDY_BIT = 0x80
const MAX_CODE = 0x0fff

const MCP4725_REGISTERS = registersFromJson(mcp4725Map as RegisterMapJson)

const DECL: DacDecl = {
  name: 'MCP4725',
  channelCount: 1,
  resolutionBits: 12,
  vrefMv: 3300,
  detailKeys: ['mode', 'eeprom'],
}

export type Mcp4725PowerDown = 'normal' | '1k' | '100k' | '500k'

export interface Mcp4725Options {
  address?: number
  name?: string
  vrefMv?: number
}

export interface Mcp4725Chip extends DacChip {
  getCode(): number
}

export function isMcp4725(chip: I2cChip | null | undefined): chip is Mcp4725Chip {
  return (
    !!chip &&
    typeof (chip as Mcp4725Chip).getCode === 'function' &&
    (chip as Mcp4725Chip).decl?.name === 'MCP4725'
  )
}

function powerDownFromBits(bits: number): Mcp4725PowerDown {
  if (bits === 1) return '1k'
  if (bits === 2) return '100k'
  if (bits === 3) return '500k'
  return 'normal'
}

function powerDownBits(pd: Mcp4725PowerDown): number {
  if (pd === '1k') return 1
  if (pd === '100k') return 2
  if (pd === '500k') return 3
  return 0
}

export function createMcp4725({
  address = 0x61,
  name = 'MCP4725 DAC',
  vrefMv = 3300,
}: Mcp4725Options = {}): Mcp4725Chip {
  const decl: DacDecl = { ...DECL, vrefMv }
  const listeners = new Set<() => void>()
  const history = createDacHistory({
    channelCount: decl.channelCount,
  })
  const byAddr = new Map(MCP4725_REGISTERS.map((r) => [r.addr, r]))

  let code = 0
  let powerDown: Mcp4725PowerDown = 'normal'
  let eepromCode: number | null = null
  let lastMode: 'fast-write' | 'eeprom' = 'fast-write'
  let status = RDY_BIT
  let generation = 0
  let pointer = ADDR_DAC_CODE
  /** How far into the current read message the next byte comes from. */
  let readOffset = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const voltsOf = (c: number) => dacCodeToVolts(c, decl)

  const setCode = (
    next: number,
    pd: Mcp4725PowerDown = powerDown,
    mode: 'fast-write' | 'eeprom' = 'fast-write',
  ) => {
    code = Math.max(0, Math.min(MAX_CODE, next & MAX_CODE))
    powerDown = pd
    lastMode = mode
    history.push(0, code, voltsOf(code))
    notify()
  }

  const peek = (addr: number): number => {
    switch (addr & 0xff) {
      case ADDR_DAC_CODE:
        return code & MAX_CODE
      case ADDR_STATUS:
        return status & 0xff
      case ADDR_EEPROM:
        return (eepromCode ?? 0) & MAX_CODE
      default:
        return 0
    }
  }

  const getChannel = (_index: number): DacChannel => ({
    index: 0,
    code,
    volts: voltsOf(code),
    powerDown,
  })

  const applyFastWrite = (b0: number, b1: number) => {
    const pdBits = (b0 >> 4) & 0x03
    const value = ((b0 & 0x0f) << 8) | (b1 & 0xff)
    setCode(value, powerDownFromBits(pdBits), 'fast-write')
  }

  /** EEPROM write: C2 C1 C0 = 010/011 (0x40/0x60) + two data bytes. */
  const applyEepromWrite = (bytes: Uint8Array) => {
    if (bytes.length < 3) return false
    const cmd = bytes[0]! & 0xe0
    if (cmd !== 0x40 && cmd !== 0x60) return false
    const pdBits = (bytes[0]! >> 1) & 0x03
    const value = ((bytes[1]! & 0x0f) << 8) | (bytes[2]! & 0xff)
    eepromCode = value & MAX_CODE
    setCode(value, powerDownFromBits(pdBits), 'eeprom')
    return true
  }

  return {
    address,
    name,
    decl,
    registers: MCP4725_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke(addr, value) {
      const a = addr & 0xff
      const reg = byAddr.get(a)
      if (!reg || reg.access === 'ro') return
      if (a === ADDR_DAC_CODE) {
        setCode(value & MAX_CODE, powerDown, 'fast-write')
        pointer = ADDR_DAC_CODE
      }
    },
    setField(addr, field, value) {
      const a = addr & 0xff
      const reg = byAddr.get(a)
      if (!reg || reg.access === 'ro') return
      if (a === ADDR_DAC_CODE) {
        setCode(insertField(peek(a), field, value) & MAX_CODE, powerDown, 'fast-write')
      }
    },
    getCode: () => code,
    getChannel,
    getHistory: (channel) => history.view(channel),
    getDetail(key) {
      if (key === 'mode') return lastMode
      if (key === 'eeprom') return eepromCode == null ? '—' : String(eepromCode)
      return ''
    },
    version: () => generation,
    write(bytes) {
      if (bytes.length === 0) return true
      // A write ends whatever read came before it, so the status frame starts
      // over — same rule as startRead below.
      readOffset = 0
      if (bytes.length >= 2 && (bytes[0]! & 0xc0) === 0) {
        applyFastWrite(bytes[0]!, bytes[1]!)
        return true
      }
      applyEepromWrite(bytes)
      return true
    },
    startRead() {
      readOffset = 0
    },

    read(length) {
      // Datasheet §6.2: byte0 status (RDY bit7), then DAC / EEPROM payload.
      // Driver only checks RDY on init — keep bit7 set.
      if (length <= 0) return new Uint8Array(0)
      const pd = powerDownBits(powerDown)
      const dac = code & MAX_CODE
      const eeprom = (eepromCode ?? 0) & MAX_CODE
      const frame = new Uint8Array([
        status | RDY_BIT,
        ((pd & 0x03) << 1) | ((dac >> 8) & 0x0f),
        dac & 0xff,
        ((pd & 0x03) << 1) | ((eeprom >> 8) & 0x0f),
        eeprom & 0xff,
      ])
      // The frame restarts on every read message, so a bus that splits one
      // into runs carries on where the last run stopped — see
      // I2cChip.startRead.
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) out[i] = frame[readOffset + i] ?? 0
      readOffset += length
      return out
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
