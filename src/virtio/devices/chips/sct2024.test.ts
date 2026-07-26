import { describe, expect, it, vi } from 'vitest'
import { createSct2024, isSct2024, sct2024Meta } from './sct2024'

function xfer(chip: ReturnType<typeof createSct2024>, hi: number, lo: number) {
  const tx = Uint8Array.of(hi, lo)
  const rx = new Uint8Array(2)
  expect(chip.transfer(tx, rx, { csChange: true, bitsPerWord: 8, mode: 0, freq: 1_000_000 })).toBe(
    true,
  )
}

describe('SCT2024 SPI LED', () => {
  it('duck-types as SCT2024', () => {
    const chip = createSct2024()
    expect(isSct2024(chip)).toBe(true)
    expect(chip.ledCount).toBe(16)
    expect(chip.cs).toBe(0)
    expect(chip.address).toBe(0)
  })

  it('loads SHIFT from a 16-bit MSB-first SPI word and auto-latches without GPIO', () => {
    const chip = createSct2024()
    xfer(chip, 0x80, 0x01) // LED15 + LED0
    expect(chip.peek(sct2024Meta.REG_SHIFT)).toBe(0x8001)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0x8001)
    expect(chip.isLedOn(0)).toBe(true)
    expect(chip.isLedOn(15)).toBe(true)
    expect(chip.isLedOn(1)).toBe(false)
    expect(chip.getBitmap()).toBe(0x8001)
  })

  it('walks bits like samples/drivers/led/sct2024', () => {
    const chip = createSct2024()
    let bitmap = 0
    for (let i = 0; i < 16; i++) {
      bitmap |= 1 << i
      xfer(chip, (bitmap >> 8) & 0xff, bitmap & 0xff)
      expect(chip.getBitmap()).toBe(bitmap)
      expect(chip.isLedOn(i)).toBe(true)
    }
    for (let i = 0; i < 16; i++) {
      bitmap &= ~(1 << i)
      xfer(chip, (bitmap >> 8) & 0xff, bitmap & 0xff)
      expect(chip.isLedOn(i)).toBe(false)
    }
    expect(chip.getBitmap()).toBe(0)
  })

  it('latches on LA rising edge when GPIO is bound', () => {
    const chip = createSct2024()
    // Match driver init: LA configured OUTPUT_INACTIVE. With ACTIVE_LOW that
    // is physical high on the LA line.
    let outputs = 1 << 6
    const listeners = new Set<() => void>()
    const gpio = {
      getOutputs: () => outputs,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const notify = () => {
      for (const fn of listeners) fn()
    }

    chip.bindGpio(gpio, { la: 6, laActiveLow: true })
    expect(chip.peek(sct2024Meta.REG_CTRL) & sct2024Meta.CTRL_LA).toBe(0)

    // SPI fills SHIFT only — no latch yet.
    xfer(chip, 0x00, 0xaa)
    expect(chip.peek(sct2024Meta.REG_SHIFT)).toBe(0x00aa)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0)

    // Driver: gpio_pin_set(LA, 1) with ACTIVE_LOW → physical 0.
    outputs = 0
    notify()
    expect(chip.peek(sct2024Meta.REG_CTRL) & sct2024Meta.CTRL_LA).toBe(sct2024Meta.CTRL_LA)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0x00aa)

    // gpio_pin_set(LA, 0) → physical 1.
    outputs = 1 << 6
    notify()
    expect(chip.peek(sct2024Meta.REG_CTRL) & sct2024Meta.CTRL_LA).toBe(0)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0x00aa)
  })

  it('blanks outputs when OE is logically inactive', () => {
    const chip = createSct2024()
    // LA inactive (phys 1), OE active/enabled (phys 0) — driver defaults.
    let outputs = 1 << 6
    const listeners = new Set<() => void>()
    const gpio = {
      getOutputs: () => outputs,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const notify = () => {
      for (const fn of listeners) fn()
    }

    chip.bindGpio(gpio, { la: 6, oe: 7, laActiveLow: true, oeActiveLow: true })
    xfer(chip, 0xff, 0xff)
    outputs = 0 // LA+OE physical low ⇒ both logically active → latch + enable
    notify()
    expect(chip.getBitmap()).toBe(0xffff)

    // OE logical inactive (blank): physical high on pin 7; keep LA inactive.
    outputs = (1 << 6) | (1 << 7)
    notify()
    expect(chip.peek(sct2024Meta.REG_CTRL) & sct2024Meta.CTRL_OE).toBe(0)
    expect(chip.getBitmap()).toBe(0)
    expect(chip.isLedOn(0)).toBe(false)
  })

  it('exposes an SVD-style register map and accepts poke/setField', () => {
    const chip = createSct2024()
    expect(chip.registers.length).toBeGreaterThanOrEqual(3)
    expect(chip.registers.map((r) => r.name)).toEqual(['SHIFT', 'LED_OUT', 'CTRL'])

    chip.poke(sct2024Meta.REG_LED_OUT, 0x0003)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0x0003)
    expect(chip.isLedOn(0)).toBe(true)
    expect(chip.isLedOn(1)).toBe(true)

    chip.setField(sct2024Meta.REG_LED_OUT, { lsb: 2, msb: 2 }, 1)
    expect(chip.peek(sct2024Meta.REG_LED_OUT)).toBe(0x0007)

    const seen = vi.fn()
    const unsub = chip.subscribe(seen)
    chip.poke(sct2024Meta.REG_SHIFT, 0x1000)
    expect(seen).toHaveBeenCalled()
    unsub()
  })

  it('rejects short SPI transfers', () => {
    const chip = createSct2024()
    expect(
      chip.transfer(Uint8Array.of(0x01), new Uint8Array(1), {
        csChange: true,
        bitsPerWord: 8,
        mode: 0,
        freq: 1_000_000,
      }),
    ).toBe(false)
  })
})
