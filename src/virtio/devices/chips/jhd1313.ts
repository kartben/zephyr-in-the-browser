/**
 * Jinghua JHD1313 Grove RGB LCD — two I²C endpoints on one module.
 *
 * LCD at 0x3e exposes an HD44780-style Instruction/Data register file
 * (`maps/jhd1313-lcd.json`): control byte `0x00`/`0x80` selects IR, `0x40`
 * selects DR. Decoded Entry_Mode / Display_Control / Function_Set / DDRAM_AC
 * shadows track what those commands programmed. The page also keeps a
 * character-cell buffer the dock paints.
 *
 * Backlight at 0x62 is a PCA9633-style register file
 * (`maps/jhd1313-backlight.json`). The LCD chip holds a link so the canvas
 * can wash with the current RGB PWM.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import backlightMap from './maps/jhd1313-backlight.json'
import lcdMap from './maps/jhd1313-lcd.json'

/* Grove / Zephyr control bytes on the LCD address. */
const CTRL_COMMAND_ALT = 0x00
const CTRL_DATA = 0x40
const CTRL_COMMAND = 0x80

/* HD44780 command bits the driver actually sends. */
const CMD_CLEAR = 0x01
const CMD_HOME = 0x02
const CMD_ENTRY = 0x04
const CMD_DISPLAY = 0x08
const CMD_SHIFT = 0x10
const CMD_FUNCTION = 0x20
const CMD_CGRAM = 0x40
const CMD_DDRAM = 0x80

const DS_DISPLAY_ON = 1 << 2
const DS_CURSOR_ON = 1 << 1
const DS_BLINK_ON = 1 << 0

const LINE_ADDR = [0x00, 0x40, 0x14, 0x54] as const

const REG_PWM_B = 0x02
const REG_PWM_G = 0x03
const REG_PWM_R = 0x04

/** I²C / decoded register addresses from jhd1313-lcd.json. */
const REG_IR = 0x00
const REG_ENTRY = 0x04
const REG_DISPLAY = 0x08
const REG_FUNCTION = 0x20
const REG_DR = 0x40
const REG_IR_CO = 0x80
const REG_DDRAM_AC = 0x81

export interface Jhd1313BacklightOptions {
  address?: number
  name?: string
}

export interface Jhd1313LcdOptions {
  address?: number
  name?: string
  columns?: number
  rows?: number
  backlight?: Jhd1313BacklightChip
}

export interface Jhd1313Rgb {
  r: number
  g: number
  b: number
}

export interface Jhd1313ControllerState {
  on: boolean
  cursor: boolean
  blinking: boolean
  cursorColumn: number
  cursorRow: number
  entryIncrement: boolean
}

export interface Jhd1313BacklightChip extends I2cChip {
  /** Same list the JSON map declared — {@link RegisterMapSource} surface. */
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  subscribe(fn: () => void): () => void
  /** RGB PWM duties the driver last wrote (0–255). */
  getRgb(): Jhd1313Rgb
}

export interface Jhd1313LcdChip extends I2cChip {
  readonly columns: number
  readonly rows: number
  /** Row-major ASCII cells; space = empty. */
  readonly cells: Uint8Array
  readonly backlight?: Jhd1313BacklightChip
  /** LCD Instruction/Data + decoded HD44780 shadows — {@link RegisterMapSource}. */
  readonly registers: readonly RegisterDecl[]
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
  isOn(): boolean
  getControllerState(): Jhd1313ControllerState
  /** Current backlight colour, or dim green-grey when unlinked / off. */
  getBacklightRgb(): Jhd1313Rgb
  version(): number
  subscribe(fn: () => void): () => void
}

const BACKLIGHT_REGISTERS = registersFromJson(backlightMap as RegisterMapJson)
const LCD_REGISTERS = registersFromJson(lcdMap as RegisterMapJson)

function isCommandControl(control: number): boolean {
  return control === CTRL_COMMAND_ALT || (control & CTRL_COMMAND) !== 0
}

function isDataControl(control: number): boolean {
  return (control & CTRL_DATA) !== 0 && !isCommandControl(control)
}

export function isJhd1313Lcd(chip: I2cChip | null | undefined): chip is Jhd1313LcdChip {
  return (
    !!chip &&
    typeof (chip as Jhd1313LcdChip).columns === 'number' &&
    typeof (chip as Jhd1313LcdChip).rows === 'number' &&
    (chip as Jhd1313LcdChip).cells instanceof Uint8Array &&
    typeof (chip as Jhd1313LcdChip).getControllerState === 'function' &&
    typeof (chip as Jhd1313LcdChip).getBacklightRgb === 'function' &&
    Array.isArray((chip as Jhd1313LcdChip).registers) &&
    // PT6314 also has columns/rows/cells — it exposes getBrightness instead.
    typeof (chip as { getBrightness?: unknown }).getBrightness !== 'function'
  )
}

export function isJhd1313Backlight(
  chip: I2cChip | null | undefined,
): chip is Jhd1313BacklightChip {
  return (
    !!chip &&
    typeof (chip as Jhd1313BacklightChip).getRgb === 'function' &&
    Array.isArray((chip as Jhd1313BacklightChip).registers) &&
    typeof (chip as Jhd1313BacklightChip).peek === 'function' &&
    !('cells' in chip) &&
    // RGB LED drivers (LP5562) also expose getRgb + a register map; they carry
    // channelCount / getChannelPwm. The PCA9633-style backlight does not.
    !('channelCount' in chip) &&
    typeof (chip as { getChannelPwm?: unknown }).getChannelPwm !== 'function'
  )
}

export function createJhd1313Backlight({
  address = 0x62,
  name = 'JHD1313 backlight',
}: Jhd1313BacklightOptions = {}): Jhd1313BacklightChip {
  const listeners = new Set<() => void>()
  const byAddr = new Map<number, RegisterDecl>()
  for (const reg of BACKLIGHT_REGISTERS) byAddr.set(reg.addr, reg)

  const words = new Map<number, number>()
  for (const reg of BACKLIGHT_REGISTERS) words.set(reg.addr, reg.reset & 0xff)

  let pointer = 0

  const notify = () => {
    for (const fn of listeners) fn()
  }

  const peek = (addr: number): number => words.get(addr) ?? 0

  const poke = (addr: number, value: number) => {
    const reg = byAddr.get(addr)
    if (!reg || reg.access === 'ro') return
    words.set(addr, value & 0xff)
    notify()
  }

  return {
    address,
    name,
    registers: BACKLIGHT_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke,
    setField(addr, field: Pick<FieldDecl, 'lsb' | 'msb'>, value) {
      const reg = byAddr.get(addr)
      if (!reg || reg.access === 'ro') return
      poke(addr, insertField(peek(addr), field, value))
    },
    getRgb: () => ({
      r: peek(REG_PWM_R),
      g: peek(REG_PWM_G),
      b: peek(REG_PWM_B),
    }),
    write(bytes) {
      if (bytes.length === 0) return true
      pointer = bytes[0] & 0xff
      if (bytes.length >= 2) {
        for (let i = 1; i < bytes.length; i++) {
          poke(pointer, bytes[i])
          pointer = (pointer + 1) & 0xff
        }
      }
      return true
    },
    read(length) {
      if (length <= 0) return new Uint8Array(0)
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = peek(pointer) & 0xff
        pointer = (pointer + 1) & 0xff
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

export function createJhd1313Lcd({
  address = 0x3e,
  name = 'JHD1313 LCD',
  columns = 16,
  rows = 2,
  backlight,
}: Jhd1313LcdOptions = {}): Jhd1313LcdChip {
  const cells = new Uint8Array(columns * rows).fill(0x20)
  const listeners = new Set<() => void>()
  const byAddr = new Map<number, RegisterDecl>()
  for (const reg of LCD_REGISTERS) byAddr.set(reg.addr, reg)

  let on = true
  let cursorOn = false
  let blinking = false
  let entryIncrement = true
  let displayShift = false
  let functionSet = CMD_FUNCTION | (1 << 4) | (1 << 3) // 8-bit, 2-line, 5×8
  let ddram = 0
  let lastIr = 0
  let lastIrCo = 0
  let lastDr = 0x20
  let pointer = REG_IR
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  const entryModeWord = () =>
    CMD_ENTRY | (entryIncrement ? 0x02 : 0) | (displayShift ? 0x01 : 0)

  const displayControlWord = () =>
    CMD_DISPLAY |
    (on ? DS_DISPLAY_ON : 0) |
    (cursorOn ? DS_CURSOR_ON : 0) |
    (blinking ? DS_BLINK_ON : 0)

  const cursorFromDdram = (): { column: number; row: number } => {
    for (let row = 0; row < rows; row++) {
      const base = LINE_ADDR[row] ?? row * 0x40
      if (ddram >= base && ddram < base + columns) {
        return { column: ddram - base, row }
      }
    }
    return { column: Math.min(ddram, columns - 1), row: 0 }
  }

  const cellIndex = (): number | null => {
    const { column, row } = cursorFromDdram()
    if (row < 0 || row >= rows || column < 0 || column >= columns) return null
    return row * columns + column
  }

  const advanceCursor = () => {
    const { column, row } = cursorFromDdram()
    if (entryIncrement) {
      if (column + 1 < columns) {
        ddram = (LINE_ADDR[row] ?? 0) + column + 1
      } else if (row + 1 < rows) {
        ddram = LINE_ADDR[row + 1] ?? 0
      }
    } else if (column > 0) {
      ddram = (LINE_ADDR[row] ?? 0) + column - 1
    }
  }

  const clear = () => {
    cells.fill(0x20)
    ddram = 0
  }

  const runCommand = (cmd: number, viaCo = false) => {
    lastIr = cmd & 0xff
    if (viaCo) lastIrCo = cmd & 0xff

    if (cmd === CMD_CLEAR) {
      clear()
      notify()
      return
    }
    if ((cmd & 0xfe) === CMD_HOME) {
      ddram = 0
      notify()
      return
    }
    if ((cmd & 0xfc) === CMD_ENTRY) {
      entryIncrement = (cmd & 0x02) !== 0
      displayShift = (cmd & 0x01) !== 0
      notify()
      return
    }
    if ((cmd & 0xf8) === CMD_DISPLAY) {
      on = (cmd & DS_DISPLAY_ON) !== 0
      cursorOn = (cmd & DS_CURSOR_ON) !== 0
      blinking = (cmd & DS_BLINK_ON) !== 0
      notify()
      return
    }
    if ((cmd & 0xf0) === CMD_SHIFT) {
      notify()
      return
    }
    if ((cmd & 0xe0) === CMD_FUNCTION) {
      functionSet = cmd & 0xff
      notify()
      return
    }
    if ((cmd & 0xc0) === CMD_CGRAM) {
      notify()
      return
    }
    if ((cmd & 0x80) === CMD_DDRAM) {
      ddram = cmd & 0x7f
      notify()
    }
  }

  const writeData = (value: number) => {
    lastDr = value & 0xff
    const idx = cellIndex()
    if (idx !== null) cells[idx] = lastDr
    advanceCursor()
    notify()
  }

  const writePair = (control: number, value: number) => {
    pointer = control & 0xff
    if (isDataControl(control)) {
      writeData(value)
      return
    }
    if (isCommandControl(control)) {
      runCommand(value, (control & CTRL_COMMAND) !== 0)
      return
    }
    runCommand(value, false)
  }

  const peek = (addr: number): number => {
    switch (addr) {
      case REG_IR:
        return lastIr
      case REG_IR_CO:
        return lastIrCo
      case REG_DR:
        return lastDr
      case REG_ENTRY:
        return entryModeWord()
      case REG_DISPLAY:
        return displayControlWord()
      case REG_FUNCTION:
        return functionSet
      case REG_DDRAM_AC:
        return CMD_DDRAM | (ddram & 0x7f)
      default:
        return 0
    }
  }

  const poke = (addr: number, value: number) => {
    const reg = byAddr.get(addr)
    if (!reg || reg.access === 'ro') return
    const v = value & 0xff
    switch (addr) {
      case REG_IR:
        writePair(CTRL_COMMAND_ALT, v)
        return
      case REG_IR_CO:
        writePair(CTRL_COMMAND, v)
        return
      case REG_DR:
        writePair(CTRL_DATA, v)
        return
      case REG_ENTRY:
        runCommand(CMD_ENTRY | (v & 0x03))
        return
      case REG_DISPLAY:
        runCommand(CMD_DISPLAY | (v & 0x07))
        return
      case REG_FUNCTION:
        runCommand(CMD_FUNCTION | (v & 0x1c))
        return
      case REG_DDRAM_AC:
        runCommand(CMD_DDRAM | (v & 0x7f), true)
        return
      default:
        return
    }
  }

  return {
    address,
    name,
    columns,
    rows,
    cells,
    backlight,
    registers: LCD_REGISTERS,
    peek,
    getPointer: () => pointer,
    poke,
    setField(addr, field: Pick<FieldDecl, 'lsb' | 'msb'>, value) {
      const reg = byAddr.get(addr)
      if (!reg || reg.access === 'ro') return
      poke(addr, insertField(peek(addr), field, value))
    },
    isOn: () => on,
    getControllerState: () => {
      const { column, row } = cursorFromDdram()
      return {
        on,
        cursor: cursorOn,
        blinking,
        cursorColumn: column,
        cursorRow: row,
        entryIncrement,
      }
    },
    getBacklightRgb: () => {
      if (!backlight) return { r: 40, g: 80, b: 60 }
      return backlight.getRgb()
    },
    version: () => generation,
    write(bytes) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        writePair(bytes[i], bytes[i + 1])
      }
      // Odd trailing control byte just moves the pointer (register select).
      if (bytes.length % 2 === 1) pointer = bytes[bytes.length - 1] & 0xff
      return true
    },
    read() {
      return null
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** Convenience: linked LCD + backlight pair at the Grove defaults. */
export function createJhd1313Pair(opts: {
  lcdAddress?: number
  backlightAddress?: number
  columns?: number
  rows?: number
} = {}): { lcd: Jhd1313LcdChip; backlight: Jhd1313BacklightChip } {
  const backlight = createJhd1313Backlight({ address: opts.backlightAddress ?? 0x62 })
  const lcd = createJhd1313Lcd({
    address: opts.lcdAddress ?? 0x3e,
    columns: opts.columns,
    rows: opts.rows,
    backlight,
  })
  return { lcd, backlight }
}
