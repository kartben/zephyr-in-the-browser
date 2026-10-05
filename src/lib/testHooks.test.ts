import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeInsights, parseDts } from '@/dts'
import type { Pin } from '@/hostGpio'
import type { TestResult } from '@/lib/testHooks'
import { parseTour } from '@/tours/parse'

/*
 * The hooks are thin on purpose: each one is a call the page's own controls
 * already make. So what is worth pinning is that they exist only when asked
 * for, and that each one reaches the same seam as its control does: the GPIO
 * bridge, the terminal, the tour store.
 */

const fake = vi.hoisted(() => ({
  buttons: [] as Pin[],
  aliases: {} as Record<string, string>,
  gpio: true,
  pressed: [] as Array<[number, boolean]>,
  canType: true,
  typed: [] as string[][],
  prompts: 0,
  threads: [] as Array<{ name: string; addr: number }>,
  tour: null as unknown,
  steps: [] as unknown[],
  seededFor: '',
  chips: [] as unknown[],
  replays: [] as unknown[][],
  playing: [] as Array<string | null>,
}))

vi.mock('@/lib/dockStore', () => ({
  getState: () => ({ seededFor: fake.seededFor }),
}))

vi.mock('@/virtio', () => ({
  i2cModel: { chips: () => fake.chips },
}))

vi.mock('@/lib/followStore', () => ({
  startReplay: (...args: unknown[]) => fake.replays.push(args),
  // What the card would show on each poll: playing, then done.
  replayingClip: () => fake.playing.shift() ?? null,
}))

vi.mock('@/hostGpio', () => ({
  available: () => fake.gpio,
  getButtons: () => fake.buttons,
  setPressed: (pin: number, pressed: boolean) => fake.pressed.push([pin, pressed]),
}))

vi.mock('@/devicetree', () => ({
  get: () => ({ insights: { aliases: fake.aliases } }),
}))

vi.mock('@/lib/terminalInput', () => ({
  canType: () => fake.canType,
  waitForPrompt: async () => {
    fake.prompts++
    return true
  },
  typeLines: async (lines: string[]) => {
    fake.typed.push([...lines])
    return true
  },
}))

vi.mock('@/debug/control', () => ({
  getSnapshot: () => ({ gdb: true, paused: false, threads: fake.threads }),
  elfAddressSources: () => ({
    symbols: { objects: new Map([['readings', { name: 'readings', addr: 0x4000_1000, size: 8 }]]) },
  }),
}))

vi.mock('@/tours/store', () => ({
  getSnapshot: () => fake.tour,
  getSteps: () => fake.steps,
}))

const { findKey, installTestHooks, wantsTestHooks } = await import('./testHooks')

function hooks() {
  const target: Pick<Window, '__zitbTest'> = {}
  installTestHooks('?test=1', target)
  return target.__zitbTest!
}

const errorOf = (result: TestResult) => (result.ok ? null : result.error)

const pin = (id: number, label: string, path?: string): Pin => ({ id, label, flags: 0, path })

beforeEach(() => {
  fake.buttons = [pin(0, 'Browser SW0'), pin(1, 'Browser SW1')]
  fake.aliases = {}
  fake.gpio = true
  fake.pressed = []
  fake.canType = true
  fake.typed = []
  fake.prompts = 0
  fake.threads = []
  fake.seededFor = ''
  fake.chips = []
  fake.replays = []
  fake.playing = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installTestHooks', () => {
  it('installs nothing without ?test', () => {
    for (const search of ['', '?board=qemu_cortex_a53&app=blinky', '?testing=1', '?profile=1']) {
      const target: Pick<Window, '__zitbTest'> = {}
      expect(installTestHooks(search, target)).toBe(false)
      expect('__zitbTest' in target).toBe(false)
    }
  })

  it('installs the hooks with ?test=1, or a bare ?test', () => {
    for (const search of ['?test=1', '?test', '?board=qemu_cortex_a53&app=blinky&test=1']) {
      const target: Pick<Window, '__zitbTest'> = {}
      expect(installTestHooks(search, target)).toBe(true)
      expect(Object.keys(target.__zitbTest!).sort()).toEqual([
        'pressKey',
        'replayGesture',
        'tourState',
        'typeLines',
      ])
    }
  })

  it('reads ?test=0 as no', () => {
    for (const value of ['0', 'no', 'false', 'off', 'NO']) {
      expect(wantsTestHooks(`?test=${value}`)).toBe(false)
    }
  })
})

describe('findKey', () => {
  it('matches a whole label or its last word, without case', () => {
    expect(findKey([pin(0, 'SW0')], 'sw0')?.id).toBe(0)
    expect(findKey([pin(0, 'Browser SW0')], 'SW0')?.id).toBe(0)
    expect(findKey([pin(0, 'Browser SW0')], 'browser sw0')?.id).toBe(0)
  })

  it('prefers a whole-label match, and refuses to guess between two', () => {
    expect(findKey([pin(0, 'Board SW0'), pin(1, 'SW0')], 'sw0')?.id).toBe(1)
    expect(findKey([pin(0, 'Board SW0'), pin(1, 'Browser SW0')], 'sw0')).toBeNull()
    expect(findKey([pin(0, 'SW0')], 'sw1')).toBeNull()
  })

  it('falls back to the key a devicetree alias points at', () => {
    // esp32c3_devkitc: `sw0 = &user_button1`, a key labelled User SW1.
    const keys = [pin(9, 'User SW1', '/gpio_keys/button_1')]
    const aliases = { sw0: '/gpio_keys/button_1', led0: '/leds/led_0' }
    expect(findKey(keys, 'sw0', aliases)?.id).toBe(9)
    expect(findKey(keys, 'SW0', aliases)?.id).toBe(9)
    expect(findKey(keys, 'sw0')).toBeNull()
    // An alias for a node that is not a key finds nothing.
    expect(findKey(keys, 'led0', aliases)).toBeNull()
  })

  it('takes a label over an alias, and an alias over two labels', () => {
    // sw0 points at the key labelled SW1, but another key is labelled SW0.
    const keys = [pin(0, 'SW0', '/keys/button_0'), pin(1, 'SW1', '/keys/button_1')]
    expect(findKey(keys, 'sw0', { sw0: '/keys/button_1' })?.id).toBe(0)
    // Two labels end in SW0, and the alias says which key it is.
    const twins = [pin(0, 'Board SW0', '/keys/button_0'), pin(1, 'Browser SW0', '/keys/button_1')]
    expect(findKey(twins, 'sw0', { sw0: '/keys/button_1' })?.id).toBe(1)
  })

  it('finds the ESP32-C3 key from the devicetree the page reads', () => {
    // Trimmed from the esp32c3_devkitc build of basic_button.
    const insights = computeInsights(
      parseDts(`
        /dts-v1/;
        / {
          aliases {
            sw0 = &user_button1;
          };
          soc {
            gpio0: gpio@60004000 {
              compatible = "espressif,esp32-gpio";
              gpio-controller;
              #gpio-cells = < 0x2 >;
              ngpios = < 0x1a >;
            };
          };
          gpio_keys {
            compatible = "gpio-keys";
            user_button1: button_1 {
              label = "User SW1";
              gpios = < &gpio0 0x9 0x11 >;
              zephyr,code = < 0xb >;
            };
          };
        };
      `),
    )
    const keys = insights.gpioControllers.find((c) => c.bridged)!.buttons
    expect(findKey(keys, 'sw0', insights.aliases)).toMatchObject({ id: 9, label: 'User SW1' })
  })
})

describe('pressKey', () => {
  it('presses, holds and releases the key, like a click on the dock', async () => {
    vi.useFakeTimers()
    const done = hooks().pressKey('sw1')
    expect(fake.pressed).toEqual([[1, true]])
    await vi.advanceTimersByTimeAsync(199)
    expect(fake.pressed).toEqual([[1, true]])
    await vi.advanceTimersByTimeAsync(1)
    await expect(done).resolves.toEqual({ ok: true })
    expect(fake.pressed).toEqual([
      [1, true],
      [1, false],
    ])
  })

  it('presses the key the running devicetree aliases', async () => {
    fake.buttons = [pin(9, 'User SW1', '/gpio_keys/button_1')]
    fake.aliases = { sw0: '/gpio_keys/button_1' }
    vi.useFakeTimers()
    const done = hooks().pressKey('sw0')
    await vi.advanceTimersByTimeAsync(200)
    await expect(done).resolves.toEqual({ ok: true })
    expect(fake.pressed).toEqual([
      [9, true],
      [9, false],
    ])
  })

  it('says which keys there are when none matches', async () => {
    expect(errorOf(await hooks().pressKey('sw7'))).toContain('Browser SW0, Browser SW1')
    expect(fake.pressed).toEqual([])
  })

  it('says so on a guest with no GPIO bridge', async () => {
    fake.gpio = false
    expect(errorOf(await hooks().pressKey('sw0'))).toContain('no GPIO bridge')
  })
})

describe('replayGesture', () => {
  const accel = { address: 0x53, decl: { shellLabel: 'adxl345', channels: [] }, setChannel: () => {} }

  it('replays the clip into the part the sample drives, and waits for it to end', async () => {
    fake.seededFor = 'qemu_cortex_a53:magic_wand'
    fake.chips = [{ address: 0x50, name: 'eeprom' }, accel]
    fake.playing = ['ring', 'ring']
    expect(await hooks().replayGesture('ring')).toEqual({ ok: true })
    expect(fake.replays).toHaveLength(1)
    const [chip, set, clip] = fake.replays[0]!
    expect(chip).toBe(accel)
    expect((set as { target: string }).target).toBe('adxl345')
    expect(clip).toBe('ring')
    expect(fake.playing).toEqual([])
  })

  it('says so for a sample with nothing to replay', async () => {
    fake.seededFor = 'qemu_cortex_a53:blinky'
    expect(errorOf(await hooks().replayGesture('ring'))).toContain('no recordings')
  })

  it('names the clips when the id matches none', async () => {
    fake.seededFor = 'qemu_cortex_a53:magic_wand'
    fake.chips = [accel]
    expect(errorOf(await hooks().replayGesture('loop'))).toContain('wing, ring, slope')
    expect(fake.replays).toEqual([])
  })

  it('says so when the part is not on the bus', async () => {
    fake.seededFor = 'qemu_cortex_a53:magic_wand_trace'
    expect(errorOf(await hooks().replayGesture('wing'))).toContain('no adxl345 on the bus')
  })
})

describe('typeLines', () => {
  it('types what Run would: placeholders filled, comments skipped, after the prompt', async () => {
    fake.threads = [{ name: 'consumer', addr: 0x4000_2000 }]
    const result = await hooks().typeLines([
      '# stop the consumer',
      'kernel thread suspend ${thread:consumer}',
      '',
      'devmem ${addr:readings}',
    ])
    expect(result).toEqual({ ok: true })
    expect(fake.prompts).toBe(1)
    expect(fake.typed).toEqual([['kernel thread suspend 0x40002000', 'devmem 0x40001000']])
  })

  it('types nothing when a placeholder does not resolve', async () => {
    expect(errorOf(await hooks().typeLines(['kernel thread suspend ${thread:consumer}']))).toContain(
      'consumer',
    )
    expect(fake.typed).toEqual([])
  })

  it('says so with no terminal', async () => {
    fake.canType = false
    expect(await hooks().typeLines(['kernel uptime'])).toEqual({
      ok: false,
      error: 'no terminal to type into',
    })
  })
})

describe('tourState', () => {
  const doc = parseTour(
    [
      '---\ntour: Button\nsample: samples/basic/button\n---\n',
      '## Main waits\n\n```tour\nat: main\nstop: no\n```\n\nProse.\n',
      '## A press\n\n```tour\nat: button_input_cb\nawait: Press **SW0**.\nci: press sw0\n```\n\nProse.\n',
      '## Done\n\nThe end.\n',
    ].join('\n'),
  )

  beforeEach(() => {
    fake.tour = {
      doc,
      enabled: true,
      armed: true,
      live: true,
      current: null,
      waiting: { index: 1, text: 'Press **SW0**.', do: [], notes: [] },
      seen: new Set([0]),
      finished: false,
      completed: false,
      problems: [],
    }
    fake.steps = [
      { step: doc.steps[0], planted: false, unresolved: false },
      { step: doc.steps[1], planted: true, unresolved: false },
    ]
  })

  it('numbers steps from 1, as the cards and data-tour-step do', () => {
    const state = hooks().tourState()
    expect(state.loaded).toBe(true)
    expect(state.title).toBe('Button')
    expect(state.outro).toBe(true)
    expect(state.waiting).toEqual({ step: 2 })
    expect(state.current).toBeNull()
    expect(state.seen).toEqual([1])
    expect(state.planted).toEqual([2])
    expect(state.unresolved).toEqual([])
    expect(state.guest).toEqual({ attached: true, paused: false })
    expect(state.steps.map((s) => [s.step, s.title, s.stop])).toEqual([
      [1, 'Main waits', false],
      [2, 'A press', true],
    ])
    expect(state.steps[1]!.ci).toEqual([{ kind: 'press', key: 'sw0' }])
  })

  it('survives the trip across page.evaluate', () => {
    const state = hooks().tourState()
    expect(JSON.parse(JSON.stringify(state))).toEqual(state)
  })

  it('reads an empty store as no tour', () => {
    fake.tour = { ...(fake.tour as object), doc: null, waiting: null, seen: new Set() }
    fake.steps = []
    const state = hooks().tourState()
    expect(state).toMatchObject({ loaded: false, title: null, steps: [], outro: false, waiting: null })
  })
})
