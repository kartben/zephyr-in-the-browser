import { describe, expect, it, vi } from 'vitest'

import { createSensorChip, type SensorChip, type SensorDecl } from './model'
import { createLm75 } from './lm75'
import { adxl345Decl, createAdxl345 } from './adxl345'
import { createLsm6dso, lsm6dsoDecl } from './lsm6dso'
import { createLps22hh } from './lps22hh'
import { createIna219 } from './ina219'
import { createIsl29035 } from './isl29035'
import { createTmp112, tmp112Decl } from './tmp112'

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

describe('LSM6DSO', () => {
  const G = 9.80665

  /** Decode a little-endian axis at ±2 g (61 µg/LSB) into m/s². */
  function decodeAccel(lo: number, hi: number): number {
    const raw = ((hi << 8) | lo) << 16 >> 16
    return raw * 61 * G * 1e-6
  }

  /** Decode a little-endian axis at ±250 dps (8750 µdps/LSB) into rad/s. */
  function decodeGyro(lo: number, hi: number): number {
    const raw = ((hi << 8) | lo) << 16 >> 16
    const tenUdeg = (raw * 8750) / 10
    return (tenUdeg * Math.PI) / 1.8e7
  }

  it('answers the WHO_AM_I probe with 0x6C', () => {
    const chip = createLsm6dso()
    chip.write(Uint8Array.of(0x0f))
    expect(Array.from(chip.read(1))).toEqual([0x6c])
  })

  it('bursts accel and gyro out of consecutive registers', () => {
    const chip = createLsm6dso()
    chip.setChannel('accel_x', 1.5)
    chip.setChannel('accel_y', -2.5)
    chip.setChannel('accel_z', G)
    chip.setChannel('gyro_x', 0.5)
    chip.setChannel('gyro_y', -0.25)
    chip.setChannel('gyro_z', 0)

    chip.write(Uint8Array.of(0x28))
    const a = Array.from(chip.read(6))
    expect(decodeAccel(a[0], a[1])).toBeCloseTo(1.5, 1)
    expect(decodeAccel(a[2], a[3])).toBeCloseTo(-2.5, 1)
    expect(decodeAccel(a[4], a[5])).toBeCloseTo(G, 1)

    chip.write(Uint8Array.of(0x22))
    const g = Array.from(chip.read(6))
    expect(decodeGyro(g[0], g[1])).toBeCloseTo(0.5, 2)
    expect(decodeGyro(g[2], g[3])).toBeCloseTo(-0.25, 2)
    expect(decodeGyro(g[4], g[5])).toBeCloseTo(0, 2)
  })

  it('exposes ODR fields the driver writes via sensor_attr_set', () => {
    const chip = createLsm6dso()
    // What st,lsm6dso does for 12.5 Hz: ODR nibble = 1 in CTRL1_XL / CTRL2_G.
    chip.write(Uint8Array.of(0x10, 0x10))
    chip.write(Uint8Array.of(0x11, 0x10))
    expect(chip.getAttr('accel_odr')).toBe(1)
    expect(chip.getAttr('gyro_odr')).toBe(1)

    chip.setAttr('accel_odr', 4) // 104 Hz from the panel
    chip.write(Uint8Array.of(0x10))
    expect(Array.from(chip.read(1))).toEqual([0x40])
  })

  it('scales accel encoding with the full-scale field', () => {
    const chip = createLsm6dso()
    chip.setChannel('accel_x', G)
    chip.setAttr('accel_fs', 0) // ±2 g → 61 µg/LSB
    chip.write(Uint8Array.of(0x28))
    const at2g = Array.from(chip.read(2))
    chip.setAttr('accel_fs', 2) // ±4 g → 122 µg/LSB — half the counts
    chip.write(Uint8Array.of(0x28))
    const at4g = Array.from(chip.read(2))
    const counts2 = (at2g[1] << 8) | at2g[0]
    const counts4 = (at4g[1] << 8) | at4g[0]
    expect(counts2).toBeCloseTo(counts4 * 2, -1)
  })
})

describe('LPS22HH', () => {
  it('answers WHO_AM_I with 0xB3 and keeps STATUS ready', () => {
    const chip = createLps22hh()
    chip.write(Uint8Array.of(0x0f))
    expect(Array.from(chip.read(1))).toEqual([0xb3])
    chip.write(Uint8Array.of(0x27))
    expect(Array.from(chip.read(1))).toEqual([0x03])
  })

  it('bursts a 24-bit pressure sample that decodes to kPa', () => {
    const chip = createLps22hh()
    chip.setChannel('pressure', 101.325)
    chip.write(Uint8Array.of(0x28))
    const [xl, l, h] = Array.from(chip.read(3))
    const raw = xl | (l << 8) | (h << 16)
    // HAL left-aligns then Zephyr does >> 8; on-wire count / 40960 = kPa.
    expect(raw / 40960).toBeCloseTo(101.325, 2)
  })

  it('encodes temperature at 100 LSB/°C', () => {
    const chip = createLps22hh()
    chip.setChannel('temp', 21.5)
    chip.write(Uint8Array.of(0x2b))
    const [lo, hi] = Array.from(chip.read(2))
    const raw = ((hi << 8) | lo) << 16 >> 16
    expect(raw / 100).toBeCloseTo(21.5, 4)
  })
})

describe('INA219', () => {
  it('keeps CNVR set so the conversion poll returns immediately', () => {
    const chip = createIna219()
    chip.setChannel('voltage', 3.3)
    chip.write(Uint8Array.of(0x02))
    const [hi, lo] = Array.from(chip.read(2))
    const word = (hi << 8) | lo
    expect(word & 0x02).toBe(0x02) // CNVR
    expect(((word >> 3) & 0x3fff) * 0.004).toBeCloseTo(3.3, 2)
  })

  it('round-trips current at the sample overlay LSB', () => {
    const chip = createIna219()
    chip.setChannel('current', 0.157)
    chip.write(Uint8Array.of(0x04))
    const [hi, lo] = Array.from(chip.read(2))
    const raw = ((hi << 8) | lo) << 16 >> 16
    expect(raw * 10 * 0.00001).toBeCloseTo(0.157, 3)
  })
})

describe('ISL29035', () => {
  it('serves LSB and MSB as separate point-then-read bytes', () => {
    const chip = createIsl29035()
    chip.setChannel('light', 1000) // 4K range → sample = 1000/4000 * 65536 = 16384
    chip.write(Uint8Array.of(0x02))
    expect(Array.from(chip.read(1))).toEqual([0x00]) // low byte of 16384
    chip.write(Uint8Array.of(0x03))
    expect(Array.from(chip.read(1))).toEqual([0x40]) // high byte
  })

  it('starts with the sample\'s 4K lux range selected', () => {
    const chip = createIsl29035()
    expect(chip.getAttr('lux_range')).toBe(1)
  })
})

describe('sensor peek / poke / setField', () => {
  const pokeDecl: SensorDecl = {
    name: 'Demo',
    defaultAddress: 0x40,
    registers: [
      {
        name: 'DATA',
        addr: 0x00,
        bytes: 2,
        access: 'ro',
        reset: 0,
        fields: [{ name: 'LEVEL', lsb: 0, msb: 15 }],
      },
      {
        name: 'CONFIG',
        addr: 0x10,
        bytes: 1,
        access: 'rw',
        reset: 0,
        fields: [
          { name: 'BOOST', lsb: 0, msb: 0 },
          {
            name: 'GAIN',
            lsb: 1,
            msb: 2,
            values: [
              { name: '1x', value: 0 },
              { name: '4x', value: 2 },
            ],
          },
        ],
      },
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
        encode: (v) => Math.round(v),
      },
    ],
  }

  it('peeks the live encoded channel word and the pointer', () => {
    const chip = createSensorChip(pokeDecl)
    chip.setChannel('level', 40)
    expect(chip.peek(0x00)).toBe(40)
    chip.write(Uint8Array.of(0x10))
    expect(chip.getPointer()).toBe(0x10)
  })

  it('pokes and setFields rw registers, ignores ro', () => {
    const chip = createSensorChip(pokeDecl)
    chip.poke(0x00, 0xffff)
    expect(chip.peek(0x00)).toBe(0) // still channel-encoded; poke ignored
    chip.setChannel('level', 0)
    expect(chip.peek(0x00)).toBe(0)

    chip.poke(0x10, 0x05) // GAIN=2, BOOST=1
    expect(chip.peek(0x10)).toBe(0x05)
    chip.setField(0x10, { lsb: 0, msb: 0 }, 0)
    expect(chip.peek(0x10)).toBe(0x04)
    chip.setField(0x10, { lsb: 1, msb: 2 }, 0)
    expect(chip.peek(0x10)).toBe(0)
  })
})

describe('JSON-backed chip maps', () => {
  it('keeps TMP112 bus behaviour while exposing named Configuration fields', () => {
    const chip = createTmp112({ celsius: 21 })
    expect(tmp112Decl.registers.find((r) => r.addr === 0x01)?.name).toBe('Configuration')
    expect(chip.peek(0x01)).toBe(0x60a0)
    const before = chip.peek(0x00)
    chip.setField(0x01, { lsb: 4, msb: 4 }, 1) // EM
    expect(chip.getAttr('extended')).toBe(true)
    // Encoding picks up EM immediately: bit 0 of the temp word mirrors it.
    expect(chip.peek(0x00) & 1).toBe(1)
    expect(chip.peek(0x00)).not.toBe(before)
  })

  it('loads ADXL345 and LSM6DSO maps with datasheet names', () => {
    expect(adxl345Decl.registers[0]?.name).toBe('DEVID')
    expect(createAdxl345().peek(0x00)).toBe(0xe5)
    expect(lsm6dsoDecl.registers.find((r) => r.addr === 0x10)?.name).toBe('CTRL1_XL')
    const imu = createLsm6dso()
    expect(imu.peek(0x0f)).toBe(0x6c)
    imu.setField(0x10, { lsb: 4, msb: 7 }, 1) // ODR 12.5 Hz
    expect(imu.getAttr('accel_odr')).toBe(1)
  })
})
