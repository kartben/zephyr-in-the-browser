/**
 * The page's virtio devices, and the one place they are registered.
 *
 * A device model here is bound to whichever `-device virtio-browser-device`
 * carries the matching `name=`; a build without that device simply never binds
 * it. Adding a device type means adding a model under `devices/` and a line
 * below — no QEMU rebuild, which is the entire point of the bridge. See
 * docs/virtio-bridge.md.
 */

import { createGpioModel } from './devices/gpio'
import { createI2cModel } from './devices/i2c'
import { createAt24 } from './devices/chips/at24'
import { createTmp112 } from './devices/chips/tmp112'
import { createLm75 } from './devices/sensors/lm75'
import { createAdxl345 } from './devices/sensors/adxl345'
import { createSsd1306 } from './devices/chips/ssd1306'
import { attach as transportAttach, detach as transportDetach, register } from './transport'

/** VIRTIO GPIO controller, name=gpio on the Cortex-A53 command line. */
export const gpioModel = createGpioModel('gpio')

/** VIRTIO I2C adapter, name=i2c. The chips on it are page-side models. */
export const i2cModel = createI2cModel('i2c')

/**
 * What is soldered to the browser's I2C bus. Attached once at module load
 * rather than per attach, so the EEPROM keeps its contents across a guest
 * restart — which is what a real board does, and what makes writing to it and
 * then rebooting a demo worth doing.
 */
export const eeprom = createAt24({ address: 0x50 })
i2cModel.attachChip(eeprom)

/**
 * The temperature parts. Both hold a reading of their own now, driven from
 * their sensor cards (src/components/SensorCard.tsx) — the retired
 * qemu,host-sensor bridge used to feed the TMP112 from a shared slider, but a
 * simulated sensor is a first-class device here, not a readout of an MMIO one.
 */
export const tmp112 = createTmp112({ address: 0x48 })
i2cModel.attachChip(tmp112)

export const lm75 = createLm75({ address: 0x49 })
i2cModel.attachChip(lm75)

/** A 3-axis accelerometer, which the card can point at the device's own tilt. */
export const adxl345 = createAdxl345({ address: 0x53 })
i2cModel.attachChip(adxl345)

/**
 * The one chip with something to show. Zephyr's stock `solomon,ssd1306-i2c`
 * renders into its GDDRAM over the bus and OledPanel paints it onto a canvas,
 * so the display API — and LVGL on top of it — ends up on a screen that is an
 * array in this module.
 */
export const ssd1306 = createSsd1306({ address: 0x3c })
i2cModel.attachChip(ssd1306)

/**
 * Called by the qemu backend once its module is live. Registration happens
 * here rather than at import time so the wiring is explicit and idempotent:
 * a model registered twice replaces itself.
 */
export function attach(mod: unknown) {
  register(gpioModel)
  register(i2cModel)
  transportAttach(mod)
}

export function detach() {
  transportDetach()
}

export { available, boundNames, isBound, subscribeBinds } from './transport'
export type { VirtioDeviceModel, VirtioRequest } from './transport'
