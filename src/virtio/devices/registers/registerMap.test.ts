import { describe, expect, it } from 'vitest'

import {
  decodeFieldLabel,
  extractField,
  fieldMask,
  formatBitRange,
  formatRegHex,
  insertField,
} from './fields'
import { mergeRegisterMap, parseHexish, registersFromJson, type RegisterMapJson } from '.'
import type { RegisterDecl } from './types'
import tmp112Map from '../sensors/maps/tmp112.json'

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
    const base: RegisterDecl[] = [
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
