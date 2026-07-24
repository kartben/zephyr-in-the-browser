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
import { attach as transportAttach, detach as transportDetach, register } from './transport'

/** VIRTIO GPIO controller, name=gpio on the Cortex-A53 command line. */
export const gpioModel = createGpioModel('gpio')

/**
 * Called by the qemu backend once its module is live. Registration happens
 * here rather than at import time so the wiring is explicit and idempotent:
 * a model registered twice replaces itself.
 */
export function attach(mod: unknown) {
  register(gpioModel)
  transportAttach(mod)
}

export function detach() {
  transportDetach()
}

export { available, boundNames, isBound, subscribeBinds } from './transport'
export type { VirtioDeviceModel, VirtioRequest } from './transport'
