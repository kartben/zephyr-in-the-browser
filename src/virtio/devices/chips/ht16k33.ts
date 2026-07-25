/**
 * Holtek HT16K33 LED matrix driver — page-side I²C model.
 *
 * Matches Zephyr's `drivers/led/ht16k33.c`: 16×8 display RAM, system/display/
 * dimming command bytes, LED index = row*8+col. Stock
 * `samples/drivers/ht16k33` drives this through the LED API.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import ht16k33Map from './maps/ht16k33.json'

const DISP_ROWS = 16
const DISP_COLS = 8
const DISP_SEGMENTS = DISP_ROWS * DISP_COLS

const CMD_DISP_DATA = 0x00
const CMD_SYSTEM_SETUP = 0x20
const CMD_DISP_SETUP = 0x80
const CMD_ROW_INT = 0xa0
const CMD_DIMMING = 0xe0

const OPT_S = 0x01
const OPT_D = 0x01

const REG_SYSTEM = 0x20
const REG_DISPLAY = 0x80
const REG_ROW_INT = 0xa0
const REG_DIMMING = 0xe0

const HT16K33_REGISTERS = registersFromJson(ht16k33Map as RegisterMapJson)

export type Ht16k33Blink = 'off' | '2hz' | '1hz' | '0.5hz'

export interface Ht16k33Options {
  address?: number
  name?: string
}

export interface Ht16k33Chip extends I2cChip {
  readonly rows: number
  readonly cols: number
  /** 16 row bytes — bit N is column N. */
  readonly memory: Uint8Array
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  isDisplayOn(): boolean
  isOscillatorOn(): boolean
  getBlink(): Ht16k33Blink
  /** Dimming level 0–15. */
  getBrightness(): number
  /** Whether LED index (0–127) is lit in RAM (ignores display-off / blink phase). */
  isLedOn(index: number): boolean
  version(): number
  subscribe(fn: () => void): () => void
}

export function isHt16k33(chip: I2cChip | null | undefined): chip is Ht16k33Chip {
  return (
    !!chip &&
    typeof (chip as Ht16k33Chip).rows === 'number' &&
    typeof (chip as Ht16k33Chip).cols === 'number' &&
    (chip as Ht16k33Chip).memory instanceof Uint8Array &&
    typeof (chip as Ht16k33Chip).getBlink === 'function' &&
    Array.isArray((chip as Ht16k33Chip).registers)
  )
}

function blinkFromSetup(setup: number): Ht16k33Blink {
  const bits = (setup >> 1) & 0x03
  if (bits === 1) return '2hz'
  if (bits === 2) return '1hz'
  if (bits === 3) return '0.5hz'
  return 'off'
}

export function createHt16k33({
  address = 0x70,
  name = 'HT16K33 LED matrix',
}: Ht16k33Options = {}): Ht16k33Chip {
  const memory = new Uint8Array(DISP_ROWS)
  const listeners = new Set<() => void>()
  const byAddr = new Map<number, RegisterDecl>()
  for (const reg of HT16K33_REGISTERS) byAddr.set(reg.addr, reg)

  let systemSetup = CMD_SYSTEM_SETUP // standby until guest enables oscillator
  let displaySetup = CMD_DISP_SETUP // display off, blink off
  let rowInt = CMD_ROW_INT
  let dimming = CMD_DIMMING | 0x0f
  let pointer = 0
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const peek = (addr: number): number => {
    if (addr >= 0x00 && addr <= 0x0f) return memory[addr] ?? 0
    switch (addr) {
      case REG_SYSTEM:
        return systemSetup
      case REG_DISPLAY:
        return displaySetup
      case REG_ROW_INT:
        return rowInt
      case REG_DIMMING:
        return dimming
      default:
        return 0
    }
  }

  const applyCommandByte = (cmd: number) => {
    if ((cmd & 0xf0) === CMD_DISP_DATA) {
      pointer = cmd & 0x0f
      return 'disp-addr'
    }
    if ((cmd & 0xfe) === CMD_SYSTEM_SETUP) {
      systemSetup = cmd & 0xff
      notify()
      return 'cmd'
    }
    if ((cmd & 0xf8) === CMD_DISP_SETUP) {
      displaySetup = cmd & 0xff
      notify()
      return 'cmd'
    }
    if ((cmd & 0xfc) === CMD_ROW_INT) {
      rowInt = cmd & 0xff
      notify()
      return 'cmd'
    }
    if ((cmd & 0xf0) === CMD_DIMMING) {
      dimming = cmd & 0xff
      notify()
      return 'cmd'
    }
    // Unknown — treat as display-data address if in 0x00–0x0F already handled.
    return 'ignore'
  }

  const writeDispBytes = (start: number, bytes: Uint8Array, offset: number) => {
    let addr = start
    let changed = false
    for (let i = offset; i < bytes.length; i++) {
      if (addr >= DISP_ROWS) break
      if (memory[addr] !== bytes[i]) {
        memory[addr] = bytes[i]
        changed = true
      }
      addr++
    }
    pointer = addr & 0x0f
    if (changed) notify()
  }

  const poke = (addr: number, value: number) => {
    const reg = byAddr.get(addr)
    if (!reg || reg.access === 'ro') return
    const v = value & 0xff
    if (addr >= 0x00 && addr <= 0x0f) {
      if (memory[addr] !== v) {
        memory[addr] = v
        notify()
      }
      return
    }
    if (addr === REG_SYSTEM) {
      applyCommandByte(CMD_SYSTEM_SETUP | (v & OPT_S))
      return
    }
    if (addr === REG_DISPLAY) {
      applyCommandByte(CMD_DISP_SETUP | (v & 0x07))
      return
    }
    if (addr === REG_ROW_INT) {
      applyCommandByte(CMD_ROW_INT | (v & 0x03))
      return
    }
    if (addr === REG_DIMMING) {
      applyCommandByte(CMD_DIMMING | (v & 0x0f))
    }
  }

  return {
    address,
    name,
    rows: DISP_ROWS,
    cols: DISP_COLS,
    memory,
    registers: HT16K33_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke,
    setField(addr, field, value) {
      const reg = byAddr.get(addr)
      if (!reg || reg.access === 'ro') return
      poke(addr, insertField(peek(addr), field, value))
    },
    isDisplayOn: () => (displaySetup & OPT_D) !== 0,
    isOscillatorOn: () => (systemSetup & OPT_S) !== 0,
    getBlink: () => blinkFromSetup(displaySetup),
    getBrightness: () => dimming & 0x0f,
    isLedOn(index) {
      if (index < 0 || index >= DISP_SEGMENTS) return false
      const row = Math.floor(index / DISP_COLS)
      const bit = index % DISP_COLS
      return (memory[row]! & (1 << bit)) !== 0
    },
    version: () => generation,
    write(bytes) {
      if (bytes.length === 0) return true
      const kind = applyCommandByte(bytes[0]!)
      if (kind === 'disp-addr') {
        writeDispBytes(bytes[0]! & 0x0f, bytes, 1)
      }
      return true
    },
    read(length) {
      // Display RAM is readable in principle; Zephyr's driver never reads.
      if (length <= 0) return new Uint8Array(0)
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = peek(pointer) & 0xff
        if (pointer < 0x0f) pointer++
      }
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
