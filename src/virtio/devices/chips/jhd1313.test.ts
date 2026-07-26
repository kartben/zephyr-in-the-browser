/**
 * JHD1313 LCD + backlight unit tests: command stream, DDRAM cells, and the
 * PCA9633-style register map the backlight exposes.
 */

import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { createLp5562 } from './lp5562'
import {
  createJhd1313Backlight,
  createJhd1313Lcd,
  createJhd1313Pair,
  isJhd1313Backlight,
  isJhd1313Lcd,
} from './jhd1313'

describe('JHD1313 backlight register map', () => {
  it('exposes a JSON-backed register map with RGB PWM regs', () => {
    const bl = createJhd1313Backlight()
    expect(isJhd1313Backlight(bl)).toBe(true)
    expect(hasRegisterMap(bl)).toBe(true)
    expect(bl.address).toBe(0x62)
    expect(bl.registers.some((r) => r.addr === 0x04 && r.name === 'PWM2_R')).toBe(true)
  })

  it('does not treat LP5562 (getRgb + registers) as the Grove backlight', () => {
    expect(isJhd1313Backlight(createLp5562())).toBe(false)
  })

  it('accepts Grove [reg, value] writes and reports RGB', () => {
    const bl = createJhd1313Backlight()
    // Init sequence from auxdisplay_jhd1313.c
    bl.write?.(new Uint8Array([0x00, 0x00]))
    bl.write?.(new Uint8Array([0x01, 0x05]))
    bl.write?.(new Uint8Array([0x08, 0xaa]))
    bl.write?.(new Uint8Array([0x04, 255])) // R
    bl.write?.(new Uint8Array([0x03, 0])) // G
    bl.write?.(new Uint8Array([0x02, 128])) // B
    expect(bl.peek(0x01)).toBe(0x05)
    expect(bl.peek(0x08)).toBe(0xaa)
    expect(bl.getRgb()).toEqual({ r: 255, g: 0, b: 128 })
  })
})

describe('JHD1313 LCD command stream', () => {
  it('writes Hello into the cell buffer the way the stock sample does', () => {
    const { lcd, backlight } = createJhd1313Pair()
    expect(isJhd1313Lcd(lcd)).toBe(true)
    expect(lcd.backlight).toBe(backlight)

    // Display on + cursor (sample enables cursor).
    lcd.write?.(new Uint8Array([0x00, 0x0e]))
    const hello = 'Hello world from'
    for (const ch of hello) {
      lcd.write?.(new Uint8Array([0x40, ch.charCodeAt(0)]))
    }
    const line0 = String.fromCharCode(...lcd.cells.subarray(0, 16))
    expect(line0).toBe('Hello world from')
    expect(lcd.getControllerState().cursor).toBe(true)
    expect(lcd.isOn()).toBe(true)
  })

  it('handles clear and DDRAM cursor set', () => {
    const lcd = createJhd1313Lcd()
    lcd.write?.(new Uint8Array([0x40, 'A'.charCodeAt(0)]))
    lcd.write?.(new Uint8Array([0x00, 0x01])) // clear
    expect(String.fromCharCode(...lcd.cells).trim()).toBe('')
    // Line 1, column 0 via Grove [0x80, 0xC0]
    lcd.write?.(new Uint8Array([0x80, 0xc0]))
    lcd.write?.(new Uint8Array([0x40, 'Z'.charCodeAt(0)]))
    expect(lcd.cells[16]).toBe('Z'.charCodeAt(0))
    expect(lcd.getControllerState()).toMatchObject({ cursorColumn: 1, cursorRow: 1 })
  })

  it('exposes an Instruction/Data register map with HD44780 shadows', () => {
    const lcd = createJhd1313Lcd()
    expect(hasRegisterMap(lcd)).toBe(true)
    expect(lcd.registers.map((r) => r.name)).toEqual([
      'Instruction',
      'Instruction_Co',
      'Data',
      'Entry_Mode',
      'Display_Control',
      'Function_Set',
      'DDRAM_AC',
    ])

    lcd.write?.(new Uint8Array([0x00, 0x0e])) // display on, cursor on
    lcd.write?.(new Uint8Array([0x00, 0x38])) // function set 8-bit 2-line
    lcd.write?.(new Uint8Array([0x40, 'Hi'.charCodeAt(0)]))
    expect(lcd.peek(0x00)).toBe(0x38)
    expect(lcd.peek(0x08) & 0x0f).toBe(0x0e) // Display_Control
    expect(lcd.peek(0x40)).toBe('H'.charCodeAt(0))

    lcd.poke(0x81, 0xc0) // DDRAM_AC → line 1
    expect(lcd.peek(0x81) & 0x7f).toBe(0x40)
    expect(lcd.getControllerState()).toMatchObject({ cursorColumn: 0, cursorRow: 1 })
  })
})
