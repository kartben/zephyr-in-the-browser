/**
 * SSD1306 OLED controller model. GDDRAM is (page, column), eight vertical
 * pixels per byte with LSB at the top. Commands outside Zephyr's path are
 * accepted and ignored because the driver never reads command state back.
 */

import type { I2cChip } from '../i2c'

const CONTROL_CMD = 0x00
const CONTROL_DATA = 0x40

const CMD_SET_CONTRAST = 0x81
const CMD_ENTIRE_DISPLAY_RESUME = 0xa4
const CMD_ENTIRE_DISPLAY_ON = 0xa5
const CMD_DISPLAY_NORMAL = 0xa6
const CMD_DISPLAY_INVERSE = 0xa7
const CMD_DISPLAY_OFF = 0xae
const CMD_DISPLAY_ON = 0xaf
const CMD_SET_MEM_ADDRESSING_MODE = 0x20
const CMD_SET_COLUMN_ADDRESS = 0x21
const CMD_SET_PAGE_ADDRESS = 0x22
const CMD_SET_MULTIPLEX_RATIO = 0xa8
const CMD_SET_DISPLAY_OFFSET = 0xd3
const CMD_SET_CLOCK_DIV_RATIO = 0xd5
const CMD_SET_CHARGE_PERIOD = 0xd9
const CMD_SET_PADS_HW_CONFIG = 0xda
const CMD_SET_VCOM_DESELECT = 0xdb
const CMD_CHARGE_PUMP = 0x8d

const MODE_HORIZONTAL = 0x00
const MODE_VERTICAL = 0x01
const MODE_PAGE = 0x02

const ONE_ARG = new Set([
  CMD_SET_CONTRAST,
  CMD_SET_MEM_ADDRESSING_MODE,
  CMD_SET_MULTIPLEX_RATIO,
  CMD_SET_DISPLAY_OFFSET,
  CMD_SET_CLOCK_DIV_RATIO,
  CMD_SET_CHARGE_PERIOD,
  CMD_SET_PADS_HW_CONFIG,
  CMD_SET_VCOM_DESELECT,
  CMD_CHARGE_PUMP,
])

const TWO_ARGS = new Set([CMD_SET_COLUMN_ADDRESS, CMD_SET_PAGE_ADDRESS])

export interface Ssd1306Options {
  address?: number
  name?: string
  width?: number
  height?: number
}

export interface Ssd1306Chip extends I2cChip {
  readonly width: number
  readonly height: number
  /** GDDRAM: one byte per (page, column), eight vertical pixels, LSB on top. */
  readonly memory: Uint8Array
  isOn(): boolean
  isInverted(): boolean
  /**
   * Live controller state derived from the last commands the guest sent —
   * not an I²C register file (the SSD1306 is a command stream). The dock's
   * Controller inspector reads this.
   */
  getControllerState(): Ssd1306ControllerState
  version(): number
  subscribe(fn: () => void): () => void
}

export interface Ssd1306ControllerState {
  on: boolean
  inverted: boolean
  contrast: number
  addressingMode: 'horizontal' | 'vertical' | 'page' | `mode-${number}`
  columnStart: number
  columnEnd: number
  pageStart: number
  pageEnd: number
  cursorColumn: number
  cursorPage: number
}

export function createSsd1306({
  address = 0x3c,
  name = 'SSD1306 OLED',
  width = 128,
  height = 64,
}: Ssd1306Options = {}): Ssd1306Chip {
  const pages = height >> 3
  const memory = new Uint8Array(pages * width)
  const listeners = new Set<() => void>()

  let on = false
  let inverted = false
  let contrast = 0x7f
  let mode = MODE_PAGE // the chip's own reset default
  let generation = 0

  let colStart = 0
  let colEnd = width - 1
  let pageStart = 0
  let pageEnd = pages - 1
  let col = 0
  let page = 0

  const modeName = (): Ssd1306ControllerState['addressingMode'] => {
    if (mode === MODE_HORIZONTAL) return 'horizontal'
    if (mode === MODE_VERTICAL) return 'vertical'
    if (mode === MODE_PAGE) return 'page'
    return `mode-${mode}`
  }

  const notify = () => {
    generation++
    for (const fn of listeners) fn()
  }

  function runCommands(bytes: Uint8Array) {
    let i = 0
    while (i < bytes.length) {
      const cmd = bytes[i++]

      if (TWO_ARGS.has(cmd)) {
        const a = bytes[i++] ?? 0
        const b = bytes[i++] ?? 0
        if (cmd === CMD_SET_COLUMN_ADDRESS) {
          colStart = Math.min(a, width - 1)
          colEnd = Math.min(b, width - 1)
          col = colStart
        } else {
          pageStart = Math.min(a, pages - 1)
          pageEnd = Math.min(b, pages - 1)
          page = pageStart
        }
        continue
      }

      if (ONE_ARG.has(cmd)) {
        const arg = bytes[i++] ?? 0
        if (cmd === CMD_SET_MEM_ADDRESSING_MODE) mode = arg & 0x03
        else if (cmd === CMD_SET_CONTRAST) contrast = arg & 0xff
        continue
      }

      switch (cmd) {
        case CMD_DISPLAY_ON:
          on = true
          notify()
          break
        case CMD_DISPLAY_OFF:
          on = false
          notify()
          break
        case CMD_DISPLAY_INVERSE:
          inverted = true
          notify()
          break
        case CMD_DISPLAY_NORMAL:
          inverted = false
          notify()
          break
        case CMD_ENTIRE_DISPLAY_ON:
        case CMD_ENTIRE_DISPLAY_RESUME:
          break
        default:
          // Page-addressing cursor commands (0xB0..0xB7 page, 0x00..0x0F and
          // 0x10..0x1F column nibbles) and everything else the driver sends
          // during init but never reads back.
          if (cmd >= 0xb0 && cmd <= 0xb7) {
            page = cmd & 0x07
          } else if (cmd <= 0x0f) {
            col = (col & 0xf0) | cmd
          } else if (cmd >= 0x10 && cmd <= 0x1f) {
            col = (col & 0x0f) | ((cmd & 0x0f) << 4)
          }
          break
      }
    }
  }

  function writeData(bytes: Uint8Array) {
    if (bytes.length === 0) return
    for (const byte of bytes) {
      if (page < pages && col < width) {
        memory[page * width + col] = byte
      }
      // Advance the cursor. Horizontal wraps column-then-page within the
      // window, vertical the other way round; page mode does not wrap at all,
      // which is what makes it page mode.
      if (mode === MODE_VERTICAL) {
        if (page++ >= pageEnd) {
          page = pageStart
          col = col >= colEnd ? colStart : col + 1
        }
      } else if (mode === MODE_HORIZONTAL) {
        if (col++ >= colEnd) {
          col = colStart
          page = page >= pageEnd ? pageStart : page + 1
        }
      } else {
        col++
      }
    }
    notify()
  }

  return {
    address,
    name,
    width,
    height,
    memory,

    write(bytes) {
      if (bytes.length === 0) return true
      const control = bytes[0]
      const payload = bytes.subarray(1)
      if (control === CONTROL_DATA) writeData(payload)
      else if (control === CONTROL_CMD) runCommands(payload)
      else {
        // Co=1 forms interleave one command per control byte. Zephyr never
        // sends them, so treating an unknown control byte as commands is the
        // closest useful guess.
        runCommands(payload)
      }
      return true
    },

    // The SSD1306 does support reads, but only of a status byte, and Zephyr's
    // driver never issues one. NAK rather than invent a response.
    read: () => null,

    isOn: () => on,
    isInverted: () => inverted,
    getControllerState: () => ({
      on,
      inverted,
      contrast,
      addressingMode: modeName(),
      columnStart: colStart,
      columnEnd: colEnd,
      pageStart,
      pageEnd,
      cursorColumn: col,
      cursorPage: page,
    }),
    version: () => generation,

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
