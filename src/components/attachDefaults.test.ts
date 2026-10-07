import { describe, expect, it } from 'vitest'
import {
  I2C_ADDR_MAX,
  I2C_ADDR_MIN,
  firstFree,
  i2cSlotFor,
  spiCsFor,
  suggestI2cAttach,
  suggestSpiAttach,
} from './attachDefaults'
import { CHIP_TYPES } from '@/virtio/devices/registry'
import { SPI_CHIP_TYPES } from '@/virtio/devices/spiRegistry'

/** What the A53 shell sample puts on its I²C bus at boot. */
const A53_SHELL_I2C = new Set([0x3e, 0x40, 0x44, 0x48, 0x49, 0x50, 0x53, 0x5c, 0x62, 0x68, 0x6a])

describe('firstFree', () => {
  it('keeps the preferred slot when it is free', () => {
    expect(firstFree(0x48, new Set(), I2C_ADDR_MIN, I2C_ADDR_MAX)).toBe(0x48)
  })

  it('counts up from the preferred slot past taken ones', () => {
    expect(firstFree(0x48, new Set([0x48, 0x49]), I2C_ADDR_MIN, I2C_ADDR_MAX)).toBe(0x4a)
  })

  it('wraps round to the bottom of the range', () => {
    expect(firstFree(0x77, new Set([0x77]), I2C_ADDR_MIN, I2C_ADDR_MAX)).toBe(0x03)
  })

  it('says so when every slot is taken', () => {
    const all = new Set(Array.from({ length: 4 }, (_, i) => i))
    expect(firstFree(1, all, 0, 3)).toBeNull()
  })
})

describe('suggestI2cAttach', () => {
  it('offers the first type on an empty bus at its own default', () => {
    const s = suggestI2cAttach(CHIP_TYPES, new Set())
    expect(s?.type.id).toBe(CHIP_TYPES[0].id)
    expect(s?.slot).toEqual({ address: CHIP_TYPES[0].defaultAddress })
  })

  it('skips types whose default is taken, so the A53 shell opens on a free part', () => {
    const s = suggestI2cAttach(CHIP_TYPES, A53_SHELL_I2C)
    expect(s).not.toBeNull()
    expect(A53_SHELL_I2C.has(s!.slot.address)).toBe(false)
    expect(s!.slot.address).toBe(s!.type.defaultAddress)
    expect(s!.type.id).toBe('ssd1306')
  })

  it('moves the first type to a free address when every default is taken', () => {
    const taken = new Set(CHIP_TYPES.flatMap((t) => [t.defaultAddress, t.secondaryAddress ?? -1]))
    const s = suggestI2cAttach(CHIP_TYPES, taken)
    expect(s?.type.id).toBe(CHIP_TYPES[0].id)
    expect(taken.has(s!.slot.address)).toBe(false)
  })

  it('returns null on a full bus', () => {
    const full = new Set(
      Array.from({ length: I2C_ADDR_MAX - I2C_ADDR_MIN + 1 }, (_, i) => I2C_ADDR_MIN + i),
    )
    expect(suggestI2cAttach(CHIP_TYPES, full)).toBeNull()
  })
})

describe('i2cSlotFor', () => {
  const jhd = CHIP_TYPES.find((t) => t.id === 'jhd1313')!

  it('gives a two-endpoint module both of its defaults when free', () => {
    expect(i2cSlotFor(jhd, new Set())).toEqual({ address: 0x3e, secondary: 0x62 })
  })

  it('moves each endpoint to a free address and never doubles them up', () => {
    const slot = i2cSlotFor(jhd, A53_SHELL_I2C)!
    expect(A53_SHELL_I2C.has(slot.address)).toBe(false)
    expect(A53_SHELL_I2C.has(slot.secondary!)).toBe(false)
    expect(slot.secondary).not.toBe(slot.address)
    expect(slot).toEqual({ address: 0x3f, secondary: 0x63 })
  })

  it('does not hand the backlight the address the LCD just took', () => {
    const type = { id: 'pair', defaultAddress: 0x10, secondaryAddress: 0x10 }
    expect(i2cSlotFor(type, new Set())).toEqual({ address: 0x10, secondary: 0x11 })
  })
})

describe('suggestSpiAttach', () => {
  it('offers the first type at CS0 on an empty bus', () => {
    expect(suggestSpiAttach(SPI_CHIP_TYPES, new Set())).toEqual({
      type: SPI_CHIP_TYPES[0],
      cs: 0,
    })
  })

  it('moves to the next free line when CS0 and CS1 are in use (A53 shell)', () => {
    const s = suggestSpiAttach(SPI_CHIP_TYPES, new Set([0, 1]))
    expect(s?.type.id).toBe(SPI_CHIP_TYPES[0].id)
    expect(s?.cs).toBe(2)
  })

  it('prefers a type whose own default line is free', () => {
    const s = suggestSpiAttach(SPI_CHIP_TYPES, new Set([0]))
    expect(s?.type.id).toBe('loopback')
    expect(s?.cs).toBe(1)
  })

  it('spiCsFor keeps the default when free and counts up when not', () => {
    expect(spiCsFor({ id: 'x', defaultCs: 0 }, new Set())).toBe(0)
    expect(spiCsFor({ id: 'x', defaultCs: 0 }, new Set([0, 1, 2]))).toBe(3)
  })
})
