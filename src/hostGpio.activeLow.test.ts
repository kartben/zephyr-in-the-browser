import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Active-low buttons, which the ESP32-C3 DevKitC is the first board here to
 * have: its sw0 is `GPIO_ACTIVE_LOW | GPIO_PULL_UP` on GPIO9.
 *
 * The panel speaks "pressed"; the device wants an electrical level, and on an
 * active-low pin those are opposites. Two things follow, and both were wrong
 * before: the pin has to *rest* high, or a guest sampling it before the first
 * press reads a button held down since boot; and pressing has to drive it low.
 * The resting level also has to reach a device that may not exist yet when the
 * page first pushes it, which is why the poll pushes it again.
 */

const tree = vi.hoisted(() => ({
  controller: {
    controllerLabel: 'gpio0',
    bridged: true,
    ngpios: 22,
    buttons: [] as { id: number; label: string; flags: number }[],
    leds: [] as { id: number; label: string; flags: number }[],
    buzzers: [],
    steppers: [],
    sevenSegs: [],
  },
}))

vi.mock('@/devicetree', () => ({
  get: () => ({ insights: { gpioControllers: [tree.controller] } }),
  subscribe: () => () => {},
}))

/** The MMIO poll hostGpio last registered, so a test can run one beat. */
const poll = vi.hoisted(() => ({ tick: null as (() => void) | null }))

vi.mock('@/hostPoll', () => ({
  HOST_POLL_MS: 100,
  isRegistered: () => false,
  register: (_id: string, _periodMs: number, tick: () => void) => {
    poll.tick = tick
  },
  unregister: () => {},
}))

vi.mock('@/virtio', () => ({
  gpioModel: {
    setInputs: () => {},
    getOutputs: () => 0,
    subscribe: () => () => {},
  },
  isBound: () => false,
  subscribeBinds: () => () => {},
}))

/** The exported pair the emulator provides; records what the device is told. */
function fakeModule() {
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

const GPIO_ACTIVE_LOW = 0x1

// The suite runs in the node environment; hostGpio coalesces its UI notifies
// through rAF, which is the only browser API it needs here.
globalThis.requestAnimationFrame ??= ((fn: FrameRequestCallback) =>
  setTimeout(() => fn(0), 0) as unknown as number) as typeof requestAnimationFrame
globalThis.cancelAnimationFrame ??= ((id: number) =>
  clearTimeout(id as unknown as NodeJS.Timeout)) as typeof cancelAnimationFrame

async function load(buttons: { id: number; label: string; flags: number }[]) {
  tree.controller.buttons = buttons
  vi.resetModules()
  return import('@/hostGpio')
}

describe('active-low buttons', () => {
  beforeEach(() => {
    tree.controller.buttons = []
  })

  it('rests high, so the guest does not see it held from boot', async () => {
    const gpio = await load([{ id: 9, label: 'User SW1', flags: GPIO_ACTIVE_LOW }])
    const { seen, mod } = fakeModule()
    gpio.attach(mod, 'mmio')

    expect(gpio.isInputHigh(9)).toBe(true)
    expect(gpio.isPressed(9)).toBe(false)
    // Whatever else it pushed, the device was told the pin sits high.
    expect(seen.at(-1)! & (1 << 9)).toBe(1 << 9)
  })

  it('pushes the resting level again, for a device that missed the first push', async () => {
    const gpio = await load([{ id: 9, label: 'User SW1', flags: GPIO_ACTIVE_LOW }])
    // The ESP32 model drops a word written before QEMU has created the device,
    // and attach() runs while the machine is still being built.
    let realized = false
    let word = 0
    gpio.attach(
      {
        _qemu_host_gpio_set_inputs: (mask: number) => {
          if (realized) word = mask
        },
        _qemu_host_gpio_get_outputs: () => 0,
      },
      'mmio',
    )
    expect(word).toBe(0)

    realized = true
    poll.tick!()
    expect(word & (1 << 9)).toBe(1 << 9)
  })

  it('drives the pin low while pressed and high again on release', async () => {
    const gpio = await load([{ id: 9, label: 'User SW1', flags: GPIO_ACTIVE_LOW }])
    const { seen, mod } = fakeModule()
    gpio.attach(mod, 'mmio')

    gpio.setPressed(9, true)
    expect(gpio.isInputHigh(9)).toBe(false)
    expect(gpio.isPressed(9)).toBe(true)
    expect(seen.at(-1)! & (1 << 9)).toBe(0)

    gpio.setPressed(9, false)
    expect(gpio.isInputHigh(9)).toBe(true)
    expect(gpio.isPressed(9)).toBe(false)
    expect(seen.at(-1)! & (1 << 9)).toBe(1 << 9)
  })

  it('leaves an ordinary active-high button alone', async () => {
    const gpio = await load([{ id: 0, label: 'SW0', flags: 0 }])
    const { seen, mod } = fakeModule()
    gpio.attach(mod, 'mmio')

    expect(gpio.isInputHigh(0)).toBe(false)
    expect(gpio.isPressed(0)).toBe(false)
    expect(seen.at(-1)! & 1).toBe(0)

    gpio.setPressed(0, true)
    expect(gpio.isInputHigh(0)).toBe(true)
    expect(gpio.isPressed(0)).toBe(true)
    expect(seen.at(-1)! & 1).toBe(1)
  })
})
