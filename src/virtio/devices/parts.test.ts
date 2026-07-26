import { describe, expect, it } from 'vitest'
import { CHIP_TYPES } from './registry'
import { SPI_CHIP_TYPES } from './spiRegistry'
import { PARTS, partByCompatible, partById, partCompatible } from './parts'

describe('PARTS catalog', () => {
  it('covers every I²C attach type', () => {
    for (const type of CHIP_TYPES) {
      const part = partById(type.id)
      expect(part, `missing identity for ${type.id}`).toBeDefined()
      expect(part!.label).toBe(type.label)
      expect(part!.defaultAddress).toBe(type.defaultAddress)
      expect(part!.bus).toBe('i2c')
      expect(part!.datasheetUrl, `${type.id} needs a datasheet`).toBeTruthy()
      expect(part!.compatible).toMatch(/,|^lm75$/)
    }
  })

  it('covers every catalogued SPI attach type', () => {
    for (const type of SPI_CHIP_TYPES.filter((t) => t.catalogued)) {
      const part = partById(type.id)
      expect(part, `missing identity for ${type.id}`).toBeDefined()
      expect(part!.bus).toBe('spi')
      expect(part!.datasheetUrl, `${type.id} needs a datasheet`).toBeTruthy()
    }
  })

  it('leaves the SPI loopback out of the catalog', () => {
    expect(partById('loopback')).toBeUndefined()
    expect(PARTS.some((p) => p.id === 'loopback')).toBe(false)
  })

  it('looks up by compatible', () => {
    expect(partByCompatible('ti,tmp112')?.id).toBe('tmp112')
    expect(partByCompatible('jedec,spi-nor')?.id).toBe('w25q')
    expect(partCompatible('ssd1306')).toBe('solomon,ssd1306')
  })

  it('has unique ids and compatibles', () => {
    const ids = PARTS.map((p) => p.id)
    const comps = PARTS.map((p) => p.compatible)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(comps).size).toBe(comps.length)
  })
})
