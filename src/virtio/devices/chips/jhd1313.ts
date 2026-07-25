/**
 * Jinghua JHD1313 Grove RGB LCD — two I²C endpoints on one module.
 *
 * LCD at 0x3e is a *command stream* (like the SSD1306): Zephyr's stock
 * `jhd,jhd1313` driver sends `[control, byte]` pairs. Control `0x40` is DDRAM
 * data; `0x00` / `0x80` are HD44780 commands. The page keeps a character-cell
 * buffer the dock paints.
 *
 * Backlight at 0x62 is a PCA9633-style *register file* — JSON map under
 * `maps/jhd1313-backlight.json`, live Registers dialog. The LCD chip holds a
 * link so the canvas can wash with the current RGB PWM.
 */

import type { I2cChip } from '../i2c'
import { insertField } from '../registers/fields'
import { registersFromJson, type RegisterMapJson } from '../registers'
import type { FieldDecl, RegisterDecl } from '../registers/types'
import backlightMap from './maps/jhd1313-backlight.json'

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
  isOn(): boolean
  getControllerState(): Jhd1313ControllerState
  /** Current backlight colour, or dim green-grey when unlinked / off. */
  getBacklightRgb(): Jhd1313Rgb
  version(): number
  subscribe(fn: () => void): () => void
}

const BACKLIGHT_REGISTERS = registersFromJson(backlightMap as RegisterMapJson)

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
    typeof (chip as Jhd1313LcdChip).getControllerState === 'function'
  )
}

export function isJhd1313Backlight(
  chip: I2cChip | null | undefined,
): chip is Jhd1313BacklightChip {
  return (
    !!chip &&
    typeof (chip as Jhd1313BacklightChip).getRgb === 'function' &&
    Array.isArray((chip as Jhd1313BacklightChip).registers) &&
    typeof (chip as Jhd1313BacklightChip).peek === 'function'
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

  let on = true
  let cursorOn = false
  let blinking = false
  let entryIncrement = true
  let ddram = 0
  let generation = 0

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

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

  const runCommand = (cmd: number) => {
    if (cmd === CMD_CLEAR || (cmd & 0xfe) === 0) {
      // CLEAR (0x01) — also tolerate HOME-only path via bit tests below.
    }
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
      // Display/cursor shift — ignore for the first cut; sample does not use it.
      return
    }
    if ((cmd & 0xe0) === CMD_FUNCTION) {
      notify()
      return
    }
    if ((cmd & 0xc0) === CMD_CGRAM) {
      // Custom characters not modelled; accept and ignore.
      return
    }
    if ((cmd & 0x80) === CMD_DDRAM) {
      ddram = cmd & 0x7f
      notify()
    }
  }

  const writeData = (value: number) => {
    const idx = cellIndex()
    if (idx !== null) cells[idx] = value & 0xff
    advanceCursor()
    notify()
  }

  const writePair = (control: number, value: number) => {
    if (isDataControl(control)) {
      writeData(value)
      return
    }
    if (isCommandControl(control)) {
      // Grove: [0x80, cmd]. Zephyr clear/init often uses [0x00, cmd].
      // Cursor set uses [0x80, ddram|0x80] — second byte is already the full
      // SET_DDRAM command, so run it directly.
      runCommand(value)
      return
    }
    // Unknown control — treat as command so we do not drop init traffic.
    runCommand(value)
  }

  return {
    address,
    name,
    columns,
    rows,
    cells,
    backlight,
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
      // Driver writes 2-byte pairs; accept longer streams of pairs too.
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        writePair(bytes[i], bytes[i + 1])
      }
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
