/**
 * The page's virtio devices, and the one place they are registered.
 *
 * A device model here is bound to whichever `-device virtio-browser-device`
 * carries the matching `name=`; a build without that device simply never binds
 * it. Adding a device type means adding a model under `devices/` and a line
 * below — no QEMU rebuild, which is the entire point of the bridge. See
 * docs/virtio-bridge.md.
 */

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

/** VIRTIO GPIO controller, name=gpio on the Cortex-A53 command line. */
export const gpioModel = createGpioModel('gpio')

/** VIRTIO I2C adapter, name=i2c. The chips on it are page-side models. */
export const i2cModel = createI2cModel('i2c')

/** VIRTIO SPI controller, name=spi. Chips selected by chip-select id. */
export const spiModel = createSpiModel('spi')

/**
 * What can be soldered to the browser's I2C bus. Instances are created once so
 * EEPROM contents (and sensor slider state) survive attach/detach within a
 * session — which is what a real board does. The AT24 also persists its
 * backing store in localStorage across page reloads ("MCU resets"), so the
 * stock EEPROM boot-counter sample keeps counting. Which of them are *on* the
 * bus follows the running build's devicetree: extra sensors stay off until a
 * snippet enables their nodes, and dedicated samples drop the default sensors
 * so the dock is not cluttered. See syncManagedChips below.
 */
export const eeprom = createAt24({ address: 0x50, persistKey: 'zephyr.eeprom.50' })

export const tmp112 = createTmp112({ address: 0x48 })

export const lm75 = createLm75({ address: 0x49 })

/** A 3-axis accelerometer, which the card can point at the device's own tilt. */
export const adxl345 = createAdxl345({ address: 0x53 })

/**
 * A 6-axis IMU (accel + gyro). The stock `st,lsm6dso` driver configures its
 * ODR through sensor attributes — which is what samples/sensor/lsm6dso shows.
 */
export const lsm6dso = createLsm6dso({ address: 0x6a })

export const lps22hh = createLps22hh({ address: 0x5c })

export const ina219 = createIna219({ address: 0x40 })

export const isl29035 = createIsl29035({ address: 0x44 })

/**
 * The one chip with something to show. Zephyr's stock `solomon,ssd1306-i2c`
 * renders into its GDDRAM over the bus and OledPanel paints it onto a canvas,
 * so the display API — and LVGL on top of it — ends up on a screen that is an
 * array in this module.
 */
export const ssd1306 = createSsd1306({ address: 0x3c })

/**
 * Grove RGB character LCD: LCD command stream at 0x3e + PCA9633-style backlight
 * register file at 0x62. Stock `jhd,jhd1313` / samples/drivers/auxdisplay.
 */
const jhd1313Pair = createJhd1313Pair()
export const jhd1313 = jhd1313Pair.lcd
export const jhd1313Backlight = jhd1313Pair.backlight

/** Holtek HT16K33 16×8 LED matrix — stock samples/drivers/ht16k33. */
export const ht16k33 = createHt16k33({ address: 0x70 })

/** TI LP5562 RGBW LED @ 0x30 — stock samples/drivers/led/lp5562. */
export const lp5562 = createLp5562({ address: 0x30 })

/** NXP PCA9685 16-ch PWM @ 0x60 — stock samples/drivers/led/pwm. */
export const pca9685 = createPca9685({ address: 0x60 })

/** Microchip MCP4725 12-bit DAC @ 0x61 — stock samples/drivers/dac. */
export const mcp4725 = createMcp4725({ address: 0x61 })

/** Maxim MAX17048 fuel gauge @ 0x36 — stock samples/drivers/fuel_gauge. */
export const max17048 = createMax17048({ address: 0x36 })

/** NXP PCF8523 RTC at the Adafruit / Zephyr shield address. */
export const pcf8523 = createPcf8523({ address: 0x68 })

/** JEDEC SPI NOR on CS0 — stock spi_flash / littlefs; persists for boot-count. */
export const w25q = createW25q({ cs: 0, persistKey: 'zephyr.w25q.0' })

/**
 * SCT2024 16-ch LED on SPI CS0 + virtio-gpio LA/OE. Shares CS0 with the NOR in
 * the managed table — syncManagedSpiChips picks by DT compatible, so only one
 * is attached for a given sample.
 */
export const sct2024 = createSct2024({ cs: 0 })

/** Board defaults + optional extras the overlay declares; keyed by address. */
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

/**
 * Managed SPI parts by Zephyr compatible chip id. CS can be shared across
 * samples (NOR vs SCT2024 both use CS0); selection is by DT `chipId`.
 */
const MANAGED_SPI_BY_ID: ReadonlyMap<string, SpiChip> = new Map<string, SpiChip>([
  ['w25q', w25q],
  ['sct2024', sct2024],
])

/** LA on virtio_gpio0 pin 6, OE on pin 7 — matches sct2024-only overlay. */
sct2024.bindGpio(gpioModel, { la: 6, oe: 7, laActiveLow: true, oeActiveLow: true })

/**
 * Addresses the running build wants answered. Prefer the loaded tree's bridged
 * slots (empty when the build has no I2C); fall back to the hardcoded defaults
 * only when no usable tree is known.
 *
 * The JHD1313 backlight lives at `backlight-addr` on the LCD node, so it never
 * appears as its own DT child — pull 0x62 in whenever the LCD slot is wanted.
 */
function wantedManagedAddresses(): Set<number> {
  const insights = getDeviceTree()?.insights
  if (insights) {
    const addrs = new Set<number>()
    for (const bus of insights.i2cBuses) {
      if (!bus.bridged) continue
      for (const slot of bus.slots) addrs.add(slot.address)
    }
    if (addrs.has(0x3e)) addrs.add(0x62)
    return addrs
  }
  return new Set(Object.keys(FALLBACK_DT_SLOTS).map(Number))
}

/**
 * Attach or detach each managed chip so the bus matches the guest DT (or the
 * fallback table). Leaves a non-managed chip the user attached alone — only
 * our singletons are steered.
 */
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

/** CS → managed chip the current DT (or fallback) wants on that select. */
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
  // Same idea as I²C FALLBACK_DT_SLOTS: before the sample DTS lands (or when
  // none is shipped), keep answering CS0 as the NOR so JEDEC probe at driver
  // init does not race an empty bus into "device not ready".
  return new Map([[w25q.cs, w25q]])
}

function syncManagedSpiChips() {
  const wanted = wantedManagedSpiChips()
  const managed = new Set(MANAGED_SPI_BY_ID.values())
  const onBus = new Map(spiModel.chips().map((chip) => [chip.cs, chip]))

  // Detach first. Doing attach-then-detach against a stale onBus snapshot
  // used to yank the newly attached chip when CS0 switched (W25Q → SCT2024):
  // detachChip(cs) removes whoever is on that CS *now*, not the snapshot entry.
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

/**
 * Called by the qemu backend once its module is live. Registration happens
 * here rather than at import time so the wiring is explicit and idempotent:
 * a model registered twice replaces itself.
 */
export function attach(mod: unknown) {
  register(gpioModel)
  register(i2cModel)
  register(spiModel)
  transportAttach(mod)
}

export function detach() {
  transportDetach()
}

export { available, boundNames, isBound, stats as bridgeStats, subscribeBinds } from './transport'
export type { BridgeStats, VirtioDeviceModel, VirtioRequest } from './transport'
