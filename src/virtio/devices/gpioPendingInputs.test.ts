import { describe, expect, it } from 'vitest'

import { createGpioModel } from './gpio'

/**
 * The CAN controller's INT line is an active-low virtio-gpio input. hostCan
 * idles it high as soon as the chip attaches, which is often before the guest
 * has read ngpio. The owning model used to mask that word with a zero
 * lineMask and drop it. Once GPIO moved into the device worker, the
 * main-thread re-push no longer reaches the copy that fires interrupts, so
 * the line stayed low and the first assert was not an edge.
 */

function config(ngpio: number): Uint8Array {
  const bytes = new Uint8Array(8)
  bytes[0] = ngpio & 0xff
  bytes[1] = (ngpio >> 8) & 0xff
  return bytes
}

describe('gpio inputs before ngpio is known', () => {
  it('applies a setInputs that arrived while lineMask was still zero', () => {
    const gpio = createGpioModel('gpio')
    gpio.setInputs(1 << 8)
    expect(gpio.getInputs()).toBe(0)

    gpio.attachConfig!(config(16), () => {})

    expect(gpio.ngpio).toBe(16)
    expect(gpio.getInputs()).toBe(1 << 8)
  })

  it('keeps the latest word when several arrive before config', () => {
    const gpio = createGpioModel('gpio')
    gpio.setInputs(1 << 8)
    gpio.setInputs(0)
    gpio.setInputs(1 << 8)

    gpio.attachConfig!(config(16), () => {})

    expect(gpio.getInputs()).toBe(1 << 8)
  })

  it('a later falling edge is a real change off that idle-high baseline', () => {
    const gpio = createGpioModel('gpio')
    gpio.setInputs(1 << 8)
    gpio.attachConfig!(config(16), () => {})

    gpio.setInputs(0)

    expect(gpio.getInputs()).toBe(0)
  })
})
