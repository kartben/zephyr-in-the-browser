import { describe, expect, it, vi } from 'vitest'

import { createSensorChip, type SensorChip, type SensorDecl } from './model'
import { createLm75 } from './lm75'
import { createAdxl345 } from './adxl345'

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

  it('notifies subscribers on channel and attribute changes', async () => {
    const chip = createSensorChip(decl)
    const fn = vi.fn()
    const off = chip.subscribe(fn)
    chip.setChannel('level', 5)
    chip.setAttr('boost', true)
    // Notifies coalesce within a turn so a multi-axis tilt update is one render.
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    chip.setChannel('level', 6)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('skips notifies when the channel value is unchanged', async () => {
    const chip = createSensorChip(decl)
    const fn = vi.fn()
    chip.subscribe(fn)
    chip.setChannel('level', 5)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    chip.setChannel('level', 5)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('skips notifies when only engineering noise changes the encoding', async () => {
    const chip = createAdxl345()
    const fn = vi.fn()
    chip.subscribe(fn)
    chip.setChannel('accel_x', 1.0)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    // Well under one LSB at 256 LSB/g (~0.038 m/s²): wire word stays put.
    chip.setChannel('accel_x', 1.0 + 0.001)
    await Promise.resolve()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(chip.getChannel('accel_x')).toBeCloseTo(1.001)
  })

  it('places a second instance at an overridden address', () => {
    const chip = createSensorChip(decl, { address: 0x41, name: 'Demo #2' })
    expect(chip.address).toBe(0x41)
    expect(chip.name).toBe('Demo #2')
  })
})

describe('LM75', () => {
  /** Decode the temp register the way the `lm75` driver does: int16 >> 7, *0.5. */
  function decode(be: number[]): number {
    const raw = (be[0] << 8) | be[1]
    const signed = (raw << 16) >> 16
    return (signed >> 7) * 0.5
  }

  function readTemp(chip: SensorChip): number {
    chip.write(Uint8Array.of(0x00))
    return decode(Array.from(chip.read(2)))
  }

  it('round-trips temperatures at 0.5 °C resolution', () => {
    const chip = createLm75()
    for (const c of [0, 22, 25.5, 0.5, 125, -0.5, -10, -55]) {
      chip.setChannel('temp', c)
      expect(readTemp(chip)).toBeCloseTo(c, 4)
    }
  })

  it('sign-extends negatives rather than wrapping', () => {
    const chip = createLm75()
    chip.setChannel('temp', -10)
    chip.write(Uint8Array.of(0x00))
    // -10 °C is -20 counts; left-justified by 7 that is 0xF600.
    expect(Array.from(chip.read(2))).toEqual([0xf6, 0x00])
  })

  it('clamps to the range the 9-bit field can hold', () => {
    const chip = createLm75()
    chip.setChannel('temp', 999)
    expect(readTemp(chip)).toBeCloseTo(127.5, 4)
    chip.setChannel('temp', -999)
    expect(readTemp(chip)).toBeCloseTo(-128, 4)
  })

  it('reads back the config byte the driver wrote', () => {
    const chip = createLm75()
    chip.write(Uint8Array.of(0x01, 0x01)) // shutdown
    expect(chip.getAttr('shutdown')).toBe(true)
    chip.write(Uint8Array.of(0x01))
    expect(Array.from(chip.read(1))).toEqual([0x01])
  })
})

describe('ADXL345', () => {
  const G = 9.80665

  /** Decode one axis: signed 16-bit little-endian, 256 LSB/g, into m/s². */
  function decodeAxis(lo: number, hi: number): number {
    const raw = ((hi << 8) | lo) << 16 >> 16
    return (raw / 256) * G
  }

  it('answers the DEVID probe with 0xE5', () => {
    const chip = createAdxl345()
    chip.write(Uint8Array.of(0x00))
    expect(Array.from(chip.read(1))).toEqual([0xe5])
  })

  it('bursts X/Y/Z out of consecutive registers in one read', () => {
    const chip = createAdxl345()
    chip.setChannel('accel_x', 1.5)
    chip.setChannel('accel_y', -2.5)
    chip.setChannel('accel_z', G)

    // What the driver does: point at DATAX0, read all six data bytes at once.
    chip.write(Uint8Array.of(0x32))
    const d = Array.from(chip.read(6))
    expect(decodeAxis(d[0], d[1])).toBeCloseTo(1.5, 1)
    expect(decodeAxis(d[2], d[3])).toBeCloseTo(-2.5, 1)
    expect(decodeAxis(d[4], d[5])).toBeCloseTo(G, 1)
  })

  it('declares a browser tilt source on every axis', () => {
    const chip = createAdxl345()
    expect(chip.decl.channels.map((c) => c.source)).toEqual([
      'orientation-x',
      'orientation-y',
      'orientation-z',
    ])
  })
})
