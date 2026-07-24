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
import { get as getSensor, subscribe as subscribeSensor } from '@/hostSensor'
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

export const tmp112 = createTmp112({ address: 0x48 })
i2cModel.attachChip(tmp112)

/**
 * The Sensor panel's temperature slider drives the TMP112 as well as the
 * `qemu,host-sensor` MMIO device it was built for. One slider, two guest-side
 * paths: a bespoke driver written for this project, and Zephyr's stock
 * `ti,tmp112` talking to a chip over a real bus. Channel 3 is Temperature —
 * see CHANNELS in src/hostSensor.ts.
 *
 * Subscribed at module load rather than on attach so the chip holds a sane
 * reading before any guest boots, and keeps it across a restart.
 */
const TEMPERATURE_CHANNEL = 3
subscribeSensor(() => {
  const celsius = getSensor(TEMPERATURE_CHANNEL)
  if (celsius !== undefined) tmp112.setCelsius(celsius)
})

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
