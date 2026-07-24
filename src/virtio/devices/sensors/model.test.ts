import { describe, expect, it, vi } from 'vitest'

import { createSensorChip, type SensorDecl } from './model'

/**
 * A made-up two-channel part exercising the machine directly (no bridge): an
 * 8-bit little-endian data pair, a config register with a bool flag and a
 * 2-bit select field, and a channel whose encoding depends on that flag.
 */
const GAIN = { shift: 1, width: 2, options: [{ label: '1x', value: 0 }, { label: '4x', value: 2 }] }
const decl: SensorDecl = {
  name: 'Demo sensor',
  defaultAddress: 0x40,
  registers: [
    { addr: 0x00, bytes: 2, access: 'ro', reset: 0 }, // level channel
    { addr: 0x02, bytes: 1, access: 'ro', reset: 0, endian: 'le' }, // byte channel
    { addr: 0x10, bytes: 2, access: 'rw', reset: 0 }, // config
  ],
  channels: [
    {
      key: 'level',
      label: 'Level',
      zephyr: 'gauge',
      unit: '%',
      min: 0,
      max: 100,
      reg: 0x00,
      // Doubles when the boost flag (bit 0 of config) is set.
      encode: (v, ctx) => Math.round(v) * (ctx.reg(0x10) & 1 ? 2 : 1),
    },
    { key: 'byte', label: 'Byte', zephyr: 'x', unit: '', min: 0, max: 255, reg: 0x02, encode: (v) => Math.round(v) },
  ],
  attributes: [
    { key: 'boost', label: 'Boost', reg: 0x10, bit: 0 },
    { key: 'gain', label: 'Gain', reg: 0x10, bits: GAIN },
  ],
}

/** Point at a register, then read `len` bytes — what i2c_burst_read does. */
function readReg(chip: ReturnType<typeof createSensorChip>, reg: number, len = 2): number[] {
  chip.write(Uint8Array.of(reg))
  return Array.from(chip.read(len))
}

describe('createSensorChip', () => {
  it('encodes a channel at read time and reflects its slider value', () => {
    const chip = createSensorChip(decl)
    chip.setChannel('level', 40)
    expect(readReg(chip, 0x00)).toEqual([0x00, 0x28]) // 40, big-endian
    chip.setChannel('level', 55)
    expect(readReg(chip, 0x00)).toEqual([0x00, 0x37])
  })

  it('lets a config attribute change how a channel encodes', () => {
    const chip = createSensorChip(decl)
    chip.setChannel('level', 40)
    chip.setAttr('boost', true)
    expect(readReg(chip, 0x00)).toEqual([0x00, 0x50]) // 40 * 2
    expect(chip.getAttr('boost')).toBe(true)
  })

  it('round-trips a rw register the way a driver reads its config back', () => {
    const chip = createSensorChip(decl)
    chip.setAttr('gain', 2) // 4x -> field 0b10 at shift 1 -> 0x0004
    expect(chip.getAttr('gain')).toBe(2)
    expect(readReg(chip, 0x10)).toEqual([0x00, 0x04])
    // A driver writing the register directly is honoured too.
    chip.write(Uint8Array.of(0x10, 0x00, 0x01))
    expect(chip.getAttr('boost')).toBe(true)
  })

  it('ignores writes to a read-only register', () => {
    const chip = createSensorChip(decl)
    chip.setChannel('level', 10)
    chip.write(Uint8Array.of(0x00, 0xff, 0xff)) // try to clobber the level reg
    expect(readReg(chip, 0x00)).toEqual([0x00, 0x0a]) // still 10
  })

  it('honours per-register width and endianness', () => {
    const chip = createSensorChip(decl)
    chip.setChannel('byte', 0xab)
    chip.write(Uint8Array.of(0x02)) // point at the 1-byte register
    expect(chip.read(1)).toEqual(Uint8Array.of(0xab))
    // A read longer than the register repeats it rather than bleeding onward.
    expect(Array.from(chip.read(3))).toEqual([0xab, 0xab, 0xab])
  })

  it('notifies subscribers on channel and attribute changes', () => {
    const chip = createSensorChip(decl)
    const fn = vi.fn()
    const off = chip.subscribe(fn)
    chip.setChannel('level', 5)
    chip.setAttr('boost', true)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    chip.setChannel('level', 6)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('places a second instance at an overridden address', () => {
    const chip = createSensorChip(decl, { address: 0x41, name: 'Demo #2' })
    expect(chip.address).toBe(0x41)
    expect(chip.name).toBe('Demo #2')
  })
})
