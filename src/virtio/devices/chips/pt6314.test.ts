/**
 * PT6314 SPI VFD unit tests: serial start-byte frames, DDRAM cells, brightness.
 */

import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { createPt6314, isPt6314, pt6314Meta } from './pt6314'

/** Zephyr auxdisplay_pt6314_spi_write(dev, flags, val) shape. */
function frame(rsData: boolean, value: number): Uint8Array {
  const start = pt6314Meta.SB_SYNC | (rsData ? pt6314Meta.SB_RS_DATA : 0)
  return new Uint8Array([start, value & 0xff])
}

function inst(chip: ReturnType<typeof createPt6314>, cmd: number) {
  chip.transfer(frame(false, cmd), new Uint8Array(2), {
    csChange: true,
    bitsPerWord: 8,
    mode: 3,
    freq: 1_000_000,
  })
}

function data(chip: ReturnType<typeof createPt6314>, value: number) {
  chip.transfer(frame(true, value), new Uint8Array(2), {
    csChange: true,
    bitsPerWord: 8,
    mode: 3,
    freq: 1_000_000,
  })
}

describe('PT6314 SPI VFD', () => {
  it('exposes a JSON-backed register map', () => {
    const chip = createPt6314()
    expect(isPt6314(chip)).toBe(true)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.columns).toBe(20)
    expect(chip.rows).toBe(2)
    expect(chip.registers.map((r) => r.name)).toEqual([
      'Start',
      'Instruction',
      'Data',
      'Entry_Mode',
      'Display_Control',
      'Function_Set',
      'DDRAM_AC',
    ])
  })

  it('writes Hello into the cell buffer the way the stock sample does', () => {
    const chip = createPt6314({ columns: 20, rows: 2 })

    // Init sequence from auxdisplay_pt6314_init: function set, display on, clear.
    inst(chip, pt6314Meta.CMD_FUNCTION | (1 << 4) | (1 << 3) | 0) // 8-bit, 2-line, 100%
    inst(chip, pt6314Meta.CMD_DISPLAY | 0x04) // display on
    inst(chip, pt6314Meta.CMD_CLEAR)

    const hello = 'Hello world from'
    for (const ch of hello) data(chip, ch.charCodeAt(0))

    const line0 = String.fromCharCode(...chip.cells.subarray(0, hello.length))
    expect(line0).toBe('Hello world from')
    expect(chip.isOn()).toBe(true)
    expect(chip.getBrightness()).toBe(4)
    expect(chip.getControllerState()).toMatchObject({
      on: true,
      cursorColumn: hello.length,
      cursorRow: 0,
    })
  })

  it('handles DDRAM cursor set onto line 1', () => {
    const chip = createPt6314()
    inst(chip, pt6314Meta.CMD_DISPLAY | 0x04)
    inst(chip, pt6314Meta.CMD_DDRAM | 0x40)
    data(chip, 'Z'.charCodeAt(0))
    expect(chip.cells[20]).toBe('Z'.charCodeAt(0))
    expect(chip.getControllerState()).toMatchObject({ cursorColumn: 1, cursorRow: 1 })
  })

  it('decodes Function Set brightness BR1:BR0 like Zephyr', () => {
    const chip = createPt6314()
    // brightness 1 → BR=11 (25%), 2 → 10, 3 → 01, 4 → 00
    for (const [level, br] of [
      [1, 3],
      [2, 2],
      [3, 1],
      [4, 0],
    ] as const) {
      const fs =
        pt6314Meta.CMD_FUNCTION | (1 << 4) | (1 << 3) | pt6314Meta.brFromBrightness(level)
      inst(chip, fs)
      expect(chip.getBrightness()).toBe(level)
      expect(chip.peek(pt6314Meta.REG_FUNCTION) & 0x03).toBe(br)
    }
  })

  it('accepts register-map poke of Instruction / Data / DDRAM_AC', () => {
    const chip = createPt6314()
    chip.poke(pt6314Meta.REG_IR, pt6314Meta.CMD_DISPLAY | 0x0e) // on + cursor
    chip.poke(pt6314Meta.REG_DR, 'H'.charCodeAt(0))
    expect(chip.cells[0]).toBe('H'.charCodeAt(0))
    expect(chip.peek(pt6314Meta.REG_DISPLAY) & 0x0f).toBe(0x0e)
    chip.poke(pt6314Meta.REG_DDRAM_AC, 0xc0)
    expect(chip.peek(pt6314Meta.REG_DDRAM_AC) & 0x7f).toBe(0x40)
    expect(chip.getControllerState()).toMatchObject({ cursorColumn: 0, cursorRow: 1 })
  })

  it('rejects undersized SPI transfers', () => {
    const chip = createPt6314()
    expect(
      chip.transfer(new Uint8Array([0xf8]), new Uint8Array(1), {
        csChange: true,
        bitsPerWord: 8,
        mode: 3,
        freq: 1_000_000,
      }),
    ).toBe(false)
  })
})
