import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { createLp5012, isLp50xx } from './lp50xx'
import { isLp5562 } from './lp5562'

describe('LP5012 RGB LED (LP50xx)', () => {
  it('exposes a register map and is not mistaken for LP5562', () => {
    const chip = createLp5012()
    expect(isLp50xx(chip)).toBe(true)
    expect(isLp5562(chip)).toBe(false)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.address).toBe(0x14)
    expect(chip.moduleCount).toBe(4)
    expect(chip.isChipEnabled()).toBe(false)
    expect(chip.registers.some((r) => r.name === 'OUT0_COLOR')).toBe(true)
  })

  it('scales module RGB by brightness after CHIP_EN', () => {
    const chip = createLp5012()
    // DEVICE_CONFIG0 |= CHIP_EN
    chip.write!(new Uint8Array([0x00, 0x40]))
    expect(chip.isChipEnabled()).toBe(true)

    // LED0 brightness = 0x80, OUT0/1/2 = R/G/B full
    chip.write!(new Uint8Array([0x07, 0x80]))
    chip.write!(new Uint8Array([0x0b, 0xff, 0x00, 0x00]))

    expect(chip.getModuleRgb(0)).toEqual({ r: 0x80, g: 0, b: 0, w: 0 })
    expect(chip.getRgb()).toEqual({ r: 0x80, g: 0, b: 0, w: 0 })
  })

  it('auto-increments through a multi-byte color write (channel API)', () => {
    const chip = createLp5012()
    chip.write!(new Uint8Array([0x00, 0x40]))
    // All four brightnesses max
    chip.write!(new Uint8Array([0x07, 0xff, 0xff, 0xff, 0xff]))
    // OUT0..OUT11 colors: LED0 cyan, others off
    chip.write!(
      new Uint8Array([
        0x0b, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
    )
    expect(chip.getModuleRgb(0)).toEqual({ r: 0, g: 0xff, b: 0xff, w: 0 })
    expect(chip.getModuleRgb(1)).toEqual({ r: 0, g: 0, b: 0, w: 0 })
  })

  it('POR via RESET 0xFF clears brightness and colors', () => {
    const chip = createLp5012()
    chip.write!(new Uint8Array([0x00, 0x40]))
    chip.write!(new Uint8Array([0x07, 0xff]))
    chip.write!(new Uint8Array([0x0b, 0xff, 0x00, 0x00]))
    chip.write!(new Uint8Array([0x17, 0xff]))
    expect(chip.isChipEnabled()).toBe(false)
    expect(chip.getModuleRgb(0)).toEqual({ r: 0, g: 0, b: 0, w: 0 })
  })

  it('LED_GLOBAL_OFF blanks outputs while chip stays enabled', () => {
    const chip = createLp5012()
    chip.write!(new Uint8Array([0x00, 0x40]))
    chip.write!(new Uint8Array([0x07, 0xff]))
    chip.write!(new Uint8Array([0x0b, 0xff, 0x00, 0x00]))
    chip.write!(new Uint8Array([0x01, 0x01])) // LED_GLOBAL_OFF
    expect(chip.isChipEnabled()).toBe(true)
    expect(chip.getModuleRgb(0)).toEqual({ r: 0, g: 0, b: 0, w: 0 })
  })
})
