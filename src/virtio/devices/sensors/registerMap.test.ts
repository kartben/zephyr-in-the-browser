import { describe, expect, it } from 'vitest'

import {
  decodeFieldLabel,
  extractField,
  fieldMask,
  formatBitRange,
  formatRegHex,
  insertField,
} from './fields'
import {
  mergeRegisterMap,
  parseHexish,
  registersFromJson,
  type RegisterMapJson,
} from './registerMap'
import { createSensorChip, type SensorDecl } from './model'
import tmp112Map from './maps/tmp112.json'
import { createTmp112, tmp112Decl } from './tmp112'
import { createLsm6dso, lsm6dsoDecl } from './lsm6dso'
import { createAdxl345, adxl345Decl } from './adxl345'

describe('field helpers', () => {
  it('extracts and inserts SVD-style inclusive bit ranges', () => {
    expect(fieldMask(4, 7)).toBe(0xf0)
    // 0x60A0 = 0110_0000_1010_0000 — bits 13:14 are R=0b11; bit 4 (EM) is clear.
    expect(extractField(0x60a0, { lsb: 13, msb: 14 })).toBe(0b11)
    expect(extractField(0x60a0, { lsb: 4, msb: 4 })).toBe(0)
    expect(insertField(0x60a0, { lsb: 4, msb: 4 }, 1)).toBe(0x60b0)
    expect(formatBitRange(3, 3)).toBe('[3]')
    expect(formatBitRange(4, 7)).toBe('[7:4]')
    expect(formatRegHex(0x60a0, 2)).toBe('0x60A0')
    expect(decodeFieldLabel({ values: [{ name: 'On', value: 1 }] }, 1)).toBe('On')
  })
})

describe('registersFromJson', () => {
  it('parses hexish addresses, resets, and nested field enums', () => {
    expect(parseHexish('0x6C')).toBe(0x6c)
    expect(parseHexish(16)).toBe(16)

    const regs = registersFromJson(tmp112Map as RegisterMapJson)
    expect(regs).toHaveLength(4)
    const config = regs.find((r) => r.addr === 0x01)!
    expect(config.name).toBe('Configuration')
    expect(config.reset).toBe(0x60a0)
    expect(config.fields?.find((f) => f.name === 'EM')).toMatchObject({ lsb: 4, msb: 4 })
    expect(config.fields?.find((f) => f.name === 'CR')?.values?.[2]).toEqual({
      name: '4 Hz',
      value: 2,
    })
  })

  it('merges JSON metadata onto an existing register list by address', () => {
    const base: SensorDecl['registers'] = [
      { addr: 0x00, bytes: 2, access: 'ro', reset: 0 },
      { addr: 0x01, bytes: 2, access: 'rw', reset: 0x60a0 },
    ]
    const merged = mergeRegisterMap(base, {
      registers: [
        {
          name: 'Temperature',
          addr: '0x00',
          bytes: 2,
          access: 'ro',
          fields: [{ name: 'TEMP', lsb: 3, msb: 15 }],
        },
      ],
    })
    expect(merged[0]?.name).toBe('Temperature')
    expect(merged[0]?.fields?.[0]?.name).toBe('TEMP')
    // Geometry from the live declaration is preserved even if JSON differed.
    expect(merged[0]?.bytes).toBe(2)
    expect(merged[1]?.name).toBeUndefined()
  })
})

describe('sensor peek / poke / setField', () => {
  const decl: SensorDecl = {
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
    const chip = createSensorChip(decl)
    chip.setChannel('level', 40)
    expect(chip.peek(0x00)).toBe(40)
    chip.write(Uint8Array.of(0x10))
    expect(chip.getPointer()).toBe(0x10)
  })

  it('pokes and setFields rw registers, ignores ro', () => {
    const chip = createSensorChip(decl)
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
