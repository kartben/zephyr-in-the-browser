import { afterEach, describe, expect, it } from 'vitest'
import { clear, setUserDts } from '@/devicetree'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import a53Blinky from '@/dts/fixtures/qemu_cortex_a53_blinky.dts?raw'
import { createLsm6dso } from './devices/sensors/lsm6dso'
import {
  adxl345,
  eeprom,
  i2cModel,
  ina219,
  isl29035,
  lm75,
  lps22hh,
  lsm6dso,
  ssd1306,
  syncManagedChips,
  tmp112,
} from './index'

afterEach(() => {
  clear()
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
  })

  it('attaches every shell extra when the shell tree arrives', () => {
    setUserDts('shell.dts', a53Shell)
    expect(addresses()).toEqual([0x3c, 0x40, 0x44, 0x48, 0x49, 0x50, 0x53, 0x5c, 0x6a])
    expect(i2cModel.chips()).toContain(lsm6dso)
  })

  it('drops managed chips when the tree has no bridged I2C bus', () => {
    setUserDts('shell.dts', a53Shell)
    expect(addresses()).toHaveLength(9)

    setUserDts('blinky.dts', a53Blinky)
    expect(addresses()).toEqual([])
  })

  it('keeps EEPROM contents across a detach/reattach cycle', () => {
    eeprom.poke(0, 0xab)

    setUserDts('blinky.dts', a53Blinky)
    expect(i2cModel.chips()).not.toContain(eeprom)

    clear()
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
})
