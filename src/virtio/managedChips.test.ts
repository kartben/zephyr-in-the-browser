import { afterEach, describe, expect, it, vi } from 'vitest'
import { clear, setUserDts } from '@/devicetree'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from '@/dts/fixtures/qemu_cortex_a53_blinky.dts?raw'
import a53Sct2024 from '@/dts/fixtures/qemu_cortex_a53_sct2024.dts?raw'
import a53Ws2812 from '@/dts/fixtures/qemu_cortex_a53_ws2812.dts?raw'
import a53Pt6314 from '@/dts/fixtures/qemu_cortex_a53_pt6314.dts?raw'
import a53Tmc50xx from '@/dts/fixtures/qemu_cortex_a53_tmc50xx.dts?raw'
import { createLsm6dso } from './devices/sensors/lsm6dso'
import { createW25q, isSpiFlashChip } from './devices/chips/w25q'
import type { I2cChip } from './devices/i2c'
import {
  adxl345,
  attachUserI2c,
  attachUserSpi,
  clearUserPeripherals,
  eeprom,
  hasUserPeripherals,
  ht16k33,
  i2cModel,
  ina219,
  isl29035,
  jhd1313,
  jhd1313Backlight,
  lm75,
  lp5012,
  lp5562,
  lps22hh,
  lsm6dso,
  max17048,
  mcp4725,
  pca9685,
  pcf8523,
  pt6314,
  sct2024,
  spiModel,
  ssd1306,
  syncManagedChips,
  tmp112,
  tmc50xx,
  w25q,
  ws2812,
} from './index'
import { clearBusRoster } from './busRoster'
import { isPt6314 } from './devices/chips/pt6314'

const MANAGED_I2C: ReadonlySet<I2cChip> = new Set([
  tmp112,
  lm75,
  adxl345,
  eeprom,
  ssd1306,
  lsm6dso,
  lps22hh,
  ina219,
  isl29035,
  jhd1313,
  jhd1313Backlight,
  pcf8523,
  ht16k33,
  lp5562,
  lp5012,
  pca9685,
  mcp4725,
  max17048,
])

afterEach(async () => {
  await clear()
  clearBusRoster()
  // Drop any user-attached SPI strangers left by a test (including CS1
  // PT6314 minted for the shell tree).
  for (const chip of [...spiModel.chips()]) {
    if (
      chip !== w25q &&
      chip !== sct2024 &&
      chip !== ws2812 &&
      chip !== pt6314 &&
      chip !== tmc50xx
    ) {
      spiModel.detachChip(chip.cs)
    }
  }
  for (const chip of [...i2cModel.chips()]) {
    if (!MANAGED_I2C.has(chip)) i2cModel.detachChip(chip.address)
  }
  syncManagedChips()
})

const addresses = () => i2cModel.chips().map((c) => c.address).sort((a, b) => a - b)

describe('syncManagedChips', () => {
  it('attaches only the default board chips when no devicetree is loaded', () => {
    expect(addresses()).toEqual([0x3c, 0x48, 0x49, 0x50, 0x53])
    expect(i2cModel.chips()).toEqual(
      expect.arrayContaining([tmp112, lm75, adxl345, eeprom, ssd1306]),
    )
    expect(i2cModel.chips()).not.toContain(lsm6dso)
    expect(i2cModel.chips()).not.toContain(lps22hh)
    expect(i2cModel.chips()).not.toContain(ina219)
    expect(i2cModel.chips()).not.toContain(isl29035)
    expect(i2cModel.chips()).not.toContain(pcf8523)
  })

  it('attaches every shell extra when the shell tree arrives', () => {
    setUserDts('shell.dts', a53Shell)
    expect(addresses()).toEqual([
      0x3c, 0x3e, 0x40, 0x44, 0x48, 0x49, 0x50, 0x53, 0x5c, 0x62, 0x68, 0x6a,
    ])
    expect(i2cModel.chips()).toContain(lsm6dso)
    expect(i2cModel.chips()).toContain(pcf8523)
    expect(i2cModel.chips()).toContain(jhd1313)
    expect(i2cModel.chips()).toContain(jhd1313Backlight)
    // SPI: NOR stays on CS0; PT6314 coexists on CS1 (auxdisplays snippet).
    expect(spiModel.chips()).toContain(w25q)
    const vfd = spiModel.chips().find((c) => c.cs === 1)
    expect(vfd).toBeDefined()
    expect(isPt6314(vfd)).toBe(true)
    expect(vfd).not.toBe(pt6314) // CS0 singleton; shell uses a CS1 instance
  })

  it('persists a devicetree-managed NOR on an alternate CS independently', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    vi.useFakeTimers()

    try {
      const btSettingsDts = a53Shell.replace(
        'compatible = "ptc,pt6314";',
        'compatible = "jedec,spi-nor";',
      )
      setUserDts('bt-settings.dts', btSettingsDts)

      const settingsFlash = spiModel.chips().find((chip) => chip.cs === 1)
      if (!settingsFlash || !isSpiFlashChip(settingsFlash)) {
        throw new Error('missing CS1 settings flash')
      }
      expect(isSpiFlashChip(settingsFlash)).toBe(true)

      settingsFlash.poke(0, 0xab)
      await vi.advanceTimersByTimeAsync(300)

      expect(store.has('zephyr.w25q.1')).toBe(true)
      expect(store.has('zephyr.w25q.0')).toBe(false)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('drops managed chips when the tree has no bridged I2C bus', () => {
    setUserDts('shell.dts', a53Shell)
    expect(addresses()).toHaveLength(12)

    setUserDts('blinky.dts', a53Blinky)
    expect(addresses()).toEqual([])
  })

  it('keeps EEPROM contents across a detach/reattach cycle', async () => {
    eeprom.poke(0, 0xab)

    setUserDts('blinky.dts', a53Blinky)
    expect(i2cModel.chips()).not.toContain(eeprom)

    await clear()
    syncManagedChips()
    expect(i2cModel.chips()).toContain(eeprom)
    expect(eeprom.memory[0]).toBe(0xab)
  })

  it('leaves a user-attached chip alone when the slot is wanted', () => {
    setUserDts('shell.dts', a53Shell)
    i2cModel.detachChip(0x6a)
    const other = createLsm6dso({ address: 0x6a })
    i2cModel.attachChip(other)

    syncManagedChips()
    expect(i2cModel.chips()).toContain(other)
    expect(i2cModel.chips()).not.toContain(lsm6dso)

    i2cModel.detachChip(0x6a)
    syncManagedChips()
    expect(i2cModel.chips()).toContain(lsm6dso)
  })

  it('keeps the fallback SPI NOR on CS0 when no tree is loaded', () => {
    expect(spiModel.chips()).toEqual([w25q])
  })

  it('puts the SCT2024 on CS0 once that sample tree is loaded', () => {
    expect(spiModel.chips()).toContain(w25q)

    setUserDts('sct2024.dts', a53Sct2024)
    expect(spiModel.chips()).toEqual([sct2024])
    expect(spiModel.chips()).not.toContain(w25q)
  })

  it('puts the WS2812 on CS0 once that sample tree is loaded', () => {
    expect(spiModel.chips()).toContain(w25q)

    setUserDts('ws2812.dts', a53Ws2812)
    expect(spiModel.chips()).toEqual([ws2812])
    expect(spiModel.chips()).not.toContain(w25q)
  })

  it('puts the PT6314 on CS0 once that sample tree is loaded', () => {
    expect(spiModel.chips()).toContain(w25q)

    setUserDts('pt6314.dts', a53Pt6314)
    expect(spiModel.chips()).toEqual([pt6314])
    expect(spiModel.chips()).not.toContain(w25q)
  })

  it('puts the TMC50xx on CS0 once that sample tree is loaded', () => {
    expect(spiModel.chips()).toContain(w25q)

    setUserDts('tmc50xx.dts', a53Tmc50xx)
    expect(spiModel.chips()).toEqual([tmc50xx])
    expect(spiModel.chips()).not.toContain(w25q)
  })

  it('restores the NOR after clearing the SCT2024 tree', async () => {
    setUserDts('sct2024.dts', a53Sct2024)
    expect(spiModel.chips()).toEqual([sct2024])

    await clear()
    syncManagedChips()
    expect(spiModel.chips()).toEqual([w25q])
  })

  it('restores the NOR after clearing the WS2812 tree', async () => {
    setUserDts('ws2812.dts', a53Ws2812)
    expect(spiModel.chips()).toEqual([ws2812])

    await clear()
    syncManagedChips()
    expect(spiModel.chips()).toEqual([w25q])
  })

  it('restores the NOR after clearing the PT6314 tree', async () => {
    setUserDts('pt6314.dts', a53Pt6314)
    expect(spiModel.chips()).toEqual([pt6314])

    await clear()
    syncManagedChips()
    expect(spiModel.chips()).toEqual([w25q])
  })

  it('restores the NOR after clearing the TMC50xx tree', async () => {
    setUserDts('tmc50xx.dts', a53Tmc50xx)
    expect(spiModel.chips()).toEqual([tmc50xx])

    await clear()
    syncManagedChips()
    expect(spiModel.chips()).toEqual([w25q])
  })

  it('leaves a user-attached SPI stranger on CS0 alone', () => {
    setUserDts('sct2024.dts', a53Sct2024)
    spiModel.detachChip(0)
    const other = createW25q({ cs: 0, name: 'user NOR' })
    spiModel.attachChip(other)

    syncManagedChips()
    expect(spiModel.chips()).toEqual([other])
    expect(spiModel.chips()).not.toContain(sct2024)

    spiModel.detachChip(0)
    syncManagedChips()
    expect(spiModel.chips()).toEqual([sct2024])
  })

  it('rehydrates a user I²C Attach after the bus is cleared (MCU reset)', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })

    setUserDts('blinky.dts', a53Blinky)
    expect(addresses()).toEqual([])

    attachUserI2c('tmp112', 0x4a)
    expect(addresses()).toEqual([0x4a])

    // Simulate a document reload: empty the bus, keep localStorage.
    for (const chip of [...i2cModel.chips()]) i2cModel.detachChip(chip.address)
    expect(addresses()).toEqual([])

    syncManagedChips()
    expect(addresses()).toEqual([0x4a])
    expect(i2cModel.chips()[0]?.name).toMatch(/TMP112/i)

    vi.unstubAllGlobals()
  })

  it('rehydrates a user SPI Attach on a free CS after reload', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })

    attachUserSpi('loopback', 1)
    expect(spiModel.chips().some((c) => c.cs === 1)).toBe(true)

    for (const chip of [...spiModel.chips()]) {
      if (chip.cs === 1) spiModel.detachChip(1)
    }
    expect(spiModel.chips().some((c) => c.cs === 1)).toBe(false)

    syncManagedChips()
    expect(spiModel.chips().some((c) => c.cs === 1)).toBe(true)

    vi.unstubAllGlobals()
  })

  it('clearUserPeripherals drops breadboard parts and restores the board', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })

    setUserDts('blinky.dts', a53Blinky)
    attachUserI2c('tmp112', 0x4a)
    attachUserSpi('loopback', 1)
    expect(hasUserPeripherals()).toBe(true)

    clearUserPeripherals()
    expect(hasUserPeripherals()).toBe(false)
    expect(addresses()).toEqual([])
    expect(spiModel.chips().some((c) => c.cs === 1)).toBe(false)

    vi.unstubAllGlobals()
  })
})
