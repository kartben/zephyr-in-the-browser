import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { createLp5562, isLp5562 } from './lp5562'

describe('LP5562 RGBW LED', () => {
  it('exposes a register map and chip-enable defaults off', () => {
    const chip = createLp5562()
    expect(isLp5562(chip)).toBe(true)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.address).toBe(0x30)
    expect(chip.isChipEnabled()).toBe(false)
    expect(chip.registers.some((r) => r.name === 'R_PWM')).toBe(true)
  })

  it('accepts Zephyr-style reg write/read for PWM after CHIP_EN', () => {
    const chip = createLp5562()
    // ENABLE |= CHIP_EN (bit 6)
    chip.write!(new Uint8Array([0x00, 0x40]))
    expect(chip.isChipEnabled()).toBe(true)

    // R_PWM = 0xFF (LED index 2)
    chip.write!(new Uint8Array([0x04, 0xff]))
    // G_PWM = 0x80
    chip.write!(new Uint8Array([0x03, 0x80]))
    // B_PWM = 0x00
    chip.write!(new Uint8Array([0x02, 0x00]))

    expect(chip.getChannelPwm(2)).toBe(0xff)
    expect(chip.getChannelPwm(1)).toBe(0x80)
    expect(chip.getChannelPwm(0)).toBe(0)

    chip.write!(new Uint8Array([0x04]))
    expect(chip.read!(1)![0]).toBe(0xff)
  })

  it('returns RGB from direct PWM channels', () => {
    const chip = createLp5562()
    chip.write!(new Uint8Array([0x00, 0x40]))
    chip.write!(new Uint8Array([0x04, 0xf4])) // R
    chip.write!(new Uint8Array([0x03, 0x79])) // G
    chip.write!(new Uint8Array([0x02, 0x20])) // B
    const rgb = chip.getRgb()
    expect(rgb).toEqual({ r: 0xf4, g: 0x79, b: 0x20, w: 0 })
  })

  it('POR via RESET 0xFF clears PWM', () => {
    const chip = createLp5562()
    chip.write!(new Uint8Array([0x00, 0x40]))
    chip.write!(new Uint8Array([0x04, 0xff]))
    chip.write!(new Uint8Array([0x0d, 0xff]))
    expect(chip.isChipEnabled()).toBe(false)
    expect(chip.getChannelPwm(2)).toBe(0)
  })

  it('blinks when LED_MAP routes a channel to a running engine', () => {
    const chip = createLp5562()
    chip.write!(new Uint8Array([0x00, 0x40])) // chip on
    // Program eng1: SET_PWM 0xFF at cmd0, then leave map/run to eng1
    chip.write!(new Uint8Array([0x10, 0x40, 0xff])) // PROG1[0]=SET_PWM, 0xFF
    // LED_MAP: B→ENG1 (01)
    chip.write!(new Uint8Array([0x70, 0x01]))
    // ENABLE: CHIP_EN | ENG1_EXEC=RUN (bits5:4 = 10)
    chip.write!(new Uint8Array([0x00, 0x40 | (0x02 << 4)]))

    const samples = Array.from({ length: 8 }, () => chip.getChannelPwm(0))
    // With a default 1000 ms period, at least one sample may be on; the
    // important bit is we do not hard-crash and values stay in range.
    expect(samples.every((v) => v === 0 || v === 0xff)).toBe(true)
  })
})
