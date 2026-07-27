/**
 * HT16K33 unit tests — display RAM, dimming/blink commands, register map.
 */

import { describe, expect, it } from 'vitest'
import { formatRegisterMapLocator, hasRegisterMap } from '../registers/types'
import { createHt16k33, isHt16k33 } from './ht16k33'

describe('HT16K33', () => {
  it('exposes a JSON register map', () => {
    const chip = createHt16k33()
    expect(isHt16k33(chip)).toBe(true)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(formatRegisterMapLocator(chip)).toBe('0x70')
    expect(chip.address).toBe(0x70)
    expect(chip.rows).toBe(16)
    expect(chip.cols).toBe(8)
    expect(chip.registers.some((r) => r.name === 'Dimming')).toBe(true)
  })

  it('handles init: oscillator, clear RAM, dimming, display on', () => {
    const chip = createHt16k33()
    chip.write?.(new Uint8Array([0x21])) // system run
    const clear = new Uint8Array(17)
    clear[0] = 0x00
    chip.write?.(clear)
    chip.write?.(new Uint8Array([0xef])) // dimming full
    chip.write?.(new Uint8Array([0x81])) // display on, blink off

    expect(chip.isOscillatorOn()).toBe(true)
    expect(chip.isDisplayOn()).toBe(true)
    expect(chip.getBrightness()).toBe(15)
    expect(chip.getBlink()).toBe('off')
    expect([...chip.memory].every((b) => b === 0)).toBe(true)
  })

  it('sets LED bits the way Zephyr led_on does (row = i/8, bit = i%8)', () => {
    const chip = createHt16k33()
    // led 0 → row0 bit0
    chip.write?.(new Uint8Array([0x00, 0x01]))
    expect(chip.isLedOn(0)).toBe(true)
    // led 9 → row1 bit1: addr=1, bit=1 → [0x01, prev|0x02]
    chip.write?.(new Uint8Array([0x01, 0x02]))
    expect(chip.isLedOn(9)).toBe(true)
    expect(chip.peek(0x00)).toBe(0x01)
    expect(chip.peek(0x01)).toBe(0x02)
  })

  it('programs blink and brightness command registers', () => {
    const chip = createHt16k33()
    chip.write?.(new Uint8Array([0x83])) // display on + 2 Hz (B0)
    expect(chip.getBlink()).toBe('2hz')
    chip.write?.(new Uint8Array([0xe5])) // dim level 5
    expect(chip.getBrightness()).toBe(5)
    expect(chip.peek(0x80)).toBe(0x83)
    expect(chip.peek(0xe0)).toBe(0xe5)
  })

  it('poke on Display_Setup and DISP_ROW updates live state', () => {
    const chip = createHt16k33()
    chip.poke(0x80, 0x01) // display on
    expect(chip.isDisplayOn()).toBe(true)
    chip.poke(0x00, 0xff)
    expect(chip.memory[0]).toBe(0xff)
    for (let c = 0; c < 8; c++) expect(chip.isLedOn(c)).toBe(true)
  })
})
