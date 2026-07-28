import { afterEach, describe, expect, it } from 'vitest'
import { clear, setUserDts } from '@/devicetree'
import type { I2cChip } from './i2c'
import { CHIP_TYPES, hasDriver, declaredChip, chipType } from './registry'
import { isJhd1313Backlight, isJhd1313Lcd } from './chips/jhd1313'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from '@/dts/fixtures/qemu_cortex_a53_blinky.dts?raw'

afterEach(async () => {
  await clear()
})

describe('hasDriver', () => {
  it('answers from the fallback table when no devicetree is loaded', () => {
    expect(hasDriver(0x48)).toBe(true)
    expect(hasDriver(0x3c)).toBe(true)
    expect(hasDriver(0x20)).toBe(false)
  })

  it('answers from the loaded devicetree when one is known', () => {
    setUserDts('shell.dts', a53Shell)
    for (const address of [0x3c, 0x3e, 0x40, 0x44, 0x48, 0x49, 0x50, 0x53, 0x5c, 0x68, 0x6a]) {
      expect(hasDriver(address)).toBe(true)
    }
    expect(hasDriver(0x20)).toBe(false)
  })

  it('does not claim optional sensors from the fallback table', () => {
    expect(hasDriver(0x48)).toBe(true)
    expect(hasDriver(0x6a)).toBe(false)
    expect(hasDriver(0x5c)).toBe(false)
    expect(hasDriver(0x40)).toBe(false)
    expect(hasDriver(0x44)).toBe(false)
    expect(hasDriver(0x68)).toBe(false)
  })

  it('declares nothing when the loaded tree has no bridged bus', () => {
    setUserDts('blinky.dts', a53Blinky)
    // The fallback table would say yes; the blinky devicetree knows better.
    expect(hasDriver(0x48)).toBe(false)
    expect(hasDriver(0x3c)).toBe(false)
  })

  it('falls back again when the tree does not parse', () => {
    setUserDts('broken.dts', 'not a devicetree')
    expect(hasDriver(0x48)).toBe(true)
  })
})

describe('declaredChip', () => {
  it('names the devicetree occupant', () => {
    setUserDts('shell.dts', a53Shell)
    expect(declaredChip(0x48)).toEqual({ compatible: 'ti,tmp112', chipId: 'tmp112' })
    expect(declaredChip(0x20)).toBeUndefined()
  })

  it('names the fallback occupant without a tree', () => {
    expect(declaredChip(0x50)).toEqual({ chipId: 'at24' })
  })
})

describe('JHD1313 module attach', () => {
  it('is one picker entry that creates a linked LCD + backlight pair', () => {
    const type = chipType('jhd1313')
    expect(type?.secondaryAddress).toBe(0x62)
    expect(type?.secondaryLabel).toBe('backlight')
    const created = type!.create(0x3e, 0x62)
    expect(Array.isArray(created)).toBe(true)
    const [lcd, backlight] = created as I2cChip[]
    expect(isJhd1313Lcd(lcd)).toBe(true)
    expect(isJhd1313Backlight(backlight)).toBe(true)
    if (isJhd1313Lcd(lcd)) expect(lcd.backlight).toBe(backlight)
    expect(CHIP_TYPES.some((t) => t.id === 'jhd1313-backlight')).toBe(false)
  })
})
