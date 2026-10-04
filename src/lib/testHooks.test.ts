import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  gpio: true,
  pressed: [] as Array<[number, boolean]>,
  canType: true,
  typed: [] as string[][],
  prompts: 0,
  threads: [] as Array<{ name: string; addr: number }>,
  tour: null as unknown,
  steps: [] as unknown[],
}))

vi.mock('@/hostGpio', () => ({
  available: () => fake.gpio,
  getButtons: () => fake.buttons,
  setPressed: (pin: number, pressed: boolean) => fake.pressed.push([pin, pressed]),
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

const pin = (id: number, label: string): Pin => ({ id, label, flags: 0 })

beforeEach(() => {
  fake.buttons = [pin(0, 'Browser SW0'), pin(1, 'Browser SW1')]
  fake.gpio = true
  fake.pressed = []
  fake.canType = true
  fake.typed = []
  fake.prompts = 0
  fake.threads = []
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
      expect(Object.keys(target.__zitbTest!).sort()).toEqual(['pressKey', 'tourState', 'typeLines'])
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

  it('says which keys there are when none matches', async () => {
    expect(errorOf(await hooks().pressKey('sw7'))).toContain('Browser SW0, Browser SW1')
    expect(fake.pressed).toEqual([])
  })

  it('says so on a guest with no GPIO bridge', async () => {
    fake.gpio = false
    expect(errorOf(await hooks().pressKey('sw0'))).toContain('no GPIO bridge')
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
