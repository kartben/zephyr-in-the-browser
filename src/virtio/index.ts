/** Page-side virtio devices registered with the generic bridge. */

import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { createGpioModel } from './devices/gpio'
import { createI2cModel } from './devices/i2c'
import type { I2cChip } from './devices/i2c'
import { createSpiModel } from './devices/spi'
import type { SpiChip } from './devices/spi'
import { createAt24 } from './devices/chips/at24'
import { createW25q } from './devices/chips/w25q'
import { createSct2024 } from './devices/chips/sct2024'
import { createTmp112 } from './devices/chips/tmp112'
import { createLm75 } from './devices/sensors/lm75'
import { createAdxl345 } from './devices/sensors/adxl345'
import { createLsm6dso } from './devices/sensors/lsm6dso'
import { createLps22hh } from './devices/sensors/lps22hh'
import { createIna219 } from './devices/sensors/ina219'
import { createIsl29035 } from './devices/sensors/isl29035'
import { createSsd1306 } from './devices/chips/ssd1306'
import { createHt16k33 } from './devices/chips/ht16k33'
import { createLp5562 } from './devices/chips/lp5562'
import { createJhd1313Pair } from './devices/chips/jhd1313'
import { createMax17048 } from './devices/chips/max17048'
import { createMcp4725 } from './devices/chips/mcp4725'
import { createPca9685 } from './devices/chips/pca9685'
import { createPcf8523 } from './devices/rtc/pcf8523'
import { FALLBACK_DT_SLOTS } from './devices/registry'
import { attach as transportAttach, detach as transportDetach, register } from './transport'

export const gpioModel = createGpioModel('gpio')

export const i2cModel = createI2cModel('i2c')

export const spiModel = createSpiModel('spi')

export const eeprom = createAt24({ address: 0x50, persistKey: 'zephyr.eeprom.50' })

export const tmp112 = createTmp112({ address: 0x48 })

export const lm75 = createLm75({ address: 0x49 })

export const adxl345 = createAdxl345({ address: 0x53 })

export const lsm6dso = createLsm6dso({ address: 0x6a })

export const lps22hh = createLps22hh({ address: 0x5c })

export const ina219 = createIna219({ address: 0x40 })

export const isl29035 = createIsl29035({ address: 0x44 })

export const ssd1306 = createSsd1306({ address: 0x3c })

const jhd1313Pair = createJhd1313Pair()
export const jhd1313 = jhd1313Pair.lcd
export const jhd1313Backlight = jhd1313Pair.backlight

export const ht16k33 = createHt16k33({ address: 0x70 })

export const lp5562 = createLp5562({ address: 0x30 })

export const pca9685 = createPca9685({ address: 0x60 })

export const mcp4725 = createMcp4725({ address: 0x61 })

export const max17048 = createMax17048({ address: 0x36 })

export const pcf8523 = createPcf8523({ address: 0x68 })

export const w25q = createW25q({ cs: 0, persistKey: 'zephyr.w25q.0' })

export const sct2024 = createSct2024({ cs: 0 })

const MANAGED_CHIPS: ReadonlyMap<number, I2cChip> = new Map<number, I2cChip>([
  [0x30, lp5562],
  [0x36, max17048],
  [0x3c, ssd1306],
  [0x3e, jhd1313],
  [0x40, ina219],
  [0x44, isl29035],
  [0x48, tmp112],
  [0x49, lm75],
  [0x50, eeprom],
  [0x53, adxl345],
  [0x5c, lps22hh],
  [0x60, pca9685],
  [0x61, mcp4725],
  [0x62, jhd1313Backlight],
  [0x68, pcf8523],
  [0x6a, lsm6dso],
  [0x70, ht16k33],
])

/** CS can be shared across samples; DT `chipId` selects the managed SPI part. */
const MANAGED_SPI_BY_ID: ReadonlyMap<string, SpiChip> = new Map<string, SpiChip>([
  ['w25q', w25q],
  ['sct2024', sct2024],
])

sct2024.bindGpio(gpioModel, { la: 6, oe: 7, laActiveLow: true, oeActiveLow: true })

function wantedManagedAddresses(): Set<number> {
  const insights = getDeviceTree()?.insights
  if (insights) {
    const addrs = new Set<number>()
    for (const bus of insights.i2cBuses) {
      if (!bus.bridged) continue
      for (const slot of bus.slots) addrs.add(slot.address)
    }
    // JHD1313 backlight is a property of the LCD DT node, not its own child.
    if (addrs.has(0x3e)) addrs.add(0x62)
    return addrs
  }
  return new Set(Object.keys(FALLBACK_DT_SLOTS).map(Number))
}

export function syncManagedChips() {
  const wanted = wantedManagedAddresses()
  const onBus = new Map(i2cModel.chips().map((chip) => [chip.address, chip]))

  for (const [address, chip] of MANAGED_CHIPS) {
    const current = onBus.get(address)
    if (wanted.has(address)) {
      if (current === chip) continue
      if (current !== undefined) continue // user-attached stranger; leave it
      i2cModel.attachChip(chip)
    } else if (current === chip) {
      i2cModel.detachChip(address)
    }
  }

  syncManagedSpiChips()
}

function wantedManagedSpiChips(): Map<number, SpiChip> {
  const insights = getDeviceTree()?.insights
  if (insights) {
    const wanted = new Map<number, SpiChip>()
    for (const bus of insights.spiBuses) {
      if (!bus.bridged) continue
      for (const slot of bus.slots) {
        if (!slot.chipId) continue
        const chip = MANAGED_SPI_BY_ID.get(slot.chipId)
        if (chip) wanted.set(slot.cs, chip)
      }
    }
    return wanted
  }
  // Without a usable tree, keep CS0 as NOR so JEDEC probe sees a device.
  return new Map([[w25q.cs, w25q]])
}

function syncManagedSpiChips() {
  const wanted = wantedManagedSpiChips()
  const managed = new Set(MANAGED_SPI_BY_ID.values())
  const onBus = new Map(spiModel.chips().map((chip) => [chip.cs, chip]))

  // Drop stale managed chips before attaching what this tree wants.
  for (const [cs, chip] of onBus) {
    if (!managed.has(chip)) continue
    if (wanted.get(cs) === chip) continue
    spiModel.detachChip(cs)
  }

  for (const [cs, chip] of wanted) {
    const current = spiModel.chips().find((c) => c.cs === cs)
    if (current === chip) continue
    if (current !== undefined) continue // user-attached stranger; leave it
    spiModel.attachChip(chip)
  }
}

syncManagedChips()
subscribeDeviceTree(syncManagedChips)

export function attach(mod: unknown) {
  register(gpioModel)
  register(i2cModel)
  register(spiModel)
  transportAttach(mod)
}

export function detach() {
  transportDetach()
}

export {
  available,
  boundNames,
  isBound,
  stats as bridgeStats,
  subscribeBinds,
  wakeLatencyStats,
  notifySourceStats,
} from './transport'
export type {
  BridgeStats,
  VirtioDeviceModel,
  VirtioRequest,
  WakeLatencyStats,
  NotifySourceStats,
} from './transport'
