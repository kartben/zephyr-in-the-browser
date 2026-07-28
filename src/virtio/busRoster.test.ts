import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearBusRoster,
  forgetI2cAddress,
  forgetSpiCs,
  getBusRoster,
  rememberI2cAttach,
  rememberSpiAttach,
} from './busRoster'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

describe('busRoster', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
  })

  afterEach(() => {
    clearBusRoster()
    vi.unstubAllGlobals()
  })

  it('remembers I²C and SPI attaches across a read', () => {
    rememberI2cAttach('tmp112', 0x4a)
    rememberI2cAttach('jhd1313', 0x3e, 0x62)
    rememberSpiAttach('loopback', 1)

    expect(getBusRoster()).toEqual({
      i2c: [
        { typeId: 'tmp112', address: 0x4a },
        { typeId: 'jhd1313', address: 0x3e, secondary: 0x62 },
      ],
      spi: [{ typeId: 'loopback', cs: 1 }],
    })
  })

  it('replaces a prior claim on the same address', () => {
    rememberI2cAttach('tmp112', 0x48)
    rememberI2cAttach('lm75', 0x48)
    expect(getBusRoster().i2c).toEqual([{ typeId: 'lm75', address: 0x48 }])
  })

  it('forgets a JHD1313 entry when either endpoint is detached', () => {
    rememberI2cAttach('jhd1313', 0x3e, 0x62)
    forgetI2cAddress(0x62)
    expect(getBusRoster().i2c).toEqual([])
  })

  it('forgets a SPI CS', () => {
    rememberSpiAttach('w25q', 2)
    forgetSpiCs(2)
    expect(getBusRoster().spi).toEqual([])
  })
})
