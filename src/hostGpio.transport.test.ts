import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which device the panel drives, which the board decides and the build does
 * not.
 *
 * The riscv32 emulator exports the MMIO pair for the ESP32-C3's GPIO
 * controller, while `qemu_riscv32` in the same binary keeps its GPIO on
 * virtio. When the panel bound whatever the build exported, a press on
 * `qemu_riscv32` went to the MMIO pair and its guest never saw it, nor did the
 * panel see the guest's LED.
 */

const model = vi.hoisted(() => ({
  inputs: [] as number[],
  outputs: 0,
  listeners: new Set<() => void>(),
}))

vi.mock('@/devicetree', () => ({
  get: () => ({
    insights: {
      gpioControllers: [
        {
          controllerLabel: 'virtio_gpio0',
          bridged: true,
          ngpios: 16,
          buttons: [{ id: 0, label: 'Browser SW0', flags: 0 }],
          leds: [{ id: 4, label: 'Browser LED0', flags: 0 }],
          buzzers: [],
          steppers: [],
          sevenSegs: [],
        },
      ],
    },
  }),
  subscribe: () => () => {},
}))

vi.mock('@/hostPoll', () => ({
  HOST_POLL_MS: 100,
  isRegistered: () => false,
  register: () => {},
  unregister: () => {},
}))

vi.mock('@/virtio', () => ({
  gpioModel: {
    name: 'gpio',
    setInputs: (mask: number) => {
      model.inputs.push(mask)
    },
    getOutputs: () => model.outputs,
    getDirection: () => 'none',
    subscribe: (fn: () => void) => {
      model.listeners.add(fn)
      return () => model.listeners.delete(fn)
    },
  },
  isBound: () => true,
  subscribeBinds: () => () => {},
}))

/** A build like riscv32's: the MMIO pair is there whatever the machine. */
function moduleWithMmio() {
  const seen: number[] = []
  return {
    seen,
    mod: {
      _qemu_host_gpio_set_inputs: (mask: number) => {
        seen.push(mask)
      },
      _qemu_host_gpio_get_outputs: () => 0,
    },
  }
}

// The suite runs in the node environment; hostGpio coalesces its UI notifies
// through rAF, which is the only browser API it needs here.
globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) =>
  setTimeout(() => fn(0), 0) as unknown as number) as typeof requestAnimationFrame
globalThis.cancelAnimationFrame ??= ((id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame

async function load() {
  vi.resetModules()
  const gpio = await import('@/hostGpio')
  // Loading seeds the resting levels into the model; only what follows counts.
  model.inputs.length = 0
  return gpio
}

describe('GPIO transport', () => {
  beforeEach(() => {
    model.inputs.length = 0
    model.outputs = 0
    model.listeners.clear()
  })

  it('presses through the virtio model on a virtio board, MMIO pair or not', async () => {
    const gpio = await load()
    const { seen, mod } = moduleWithMmio()
    gpio.attach(mod, 'virtio')

    gpio.setPressed(0, true)
    expect(model.inputs.at(-1)! & 1).toBe(1)
    gpio.setPressed(0, false)
    expect(model.inputs.at(-1)! & 1).toBe(0)
    expect(seen).toEqual([])
  })

  it('lights the LED the guest drives through the virtio model', async () => {
    const gpio = await load()
    gpio.attach(moduleWithMmio().mod, 'virtio')

    model.outputs = 1 << 4
    for (const fn of model.listeners) fn()
    expect(gpio.isOutputHigh(4)).toBe(true)
  })

  it('presses through the MMIO pair on an MMIO board', async () => {
    const gpio = await load()
    const { seen, mod } = moduleWithMmio()
    gpio.attach(mod, 'mmio')

    gpio.setPressed(0, true)
    expect(seen.at(-1)! & 1).toBe(1)
    expect(model.inputs).toEqual([])
  })
})
