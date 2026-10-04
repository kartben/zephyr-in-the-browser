import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canType,
  registerTerminal,
  subscribe,
  typeLines,
  waitForPrompt,
} from '@/lib/terminalInput'

/**
 * Just enough of an xterm: an input spy, and a cursor line the "guest" can
 * print to, which fires `onWriteParsed` the way a real write does.
 */
function fakeTerminal(initial = 'uart:~$ ') {
  let line = initial
  const parsed = new Set<() => void>()
  return {
    input: vi.fn<(data: string, wasUserInput?: boolean) => void>(),
    buffer: {
      active: {
        baseY: 0,
        cursorY: 0,
        get cursorX() {
          return line.length
        },
        getLine: () => ({
          translateToString: (_trimRight?: boolean, start = 0, end?: number) =>
            line.slice(start, end),
        }),
      },
    },
    onWriteParsed(listener: () => void) {
      parsed.add(listener)
      return { dispose: () => void parsed.delete(listener) }
    },
    /** The guest printed, leaving the cursor at the end of `text`. */
    print(text: string) {
      line = text
      for (const fn of [...parsed]) fn()
    },
    get listening() {
      return parsed.size
    },
  }
}

afterEach(() => {
  registerTerminal(null)
  vi.useRealTimers()
})

describe('typeLines', () => {
  it('types nothing when no terminal is up', async () => {
    expect(canType()).toBe(false)
    expect(await typeLines(['kernel version'])).toBe(false)
  })

  it('types each line with Enter, in order', async () => {
    const term = fakeTerminal()
    registerTerminal(term)
    expect(await typeLines(['msgq consumer suspend', 'msgq stat'], 0)).toBe(true)
    expect(term.input.mock.calls.map(([data]) => data)).toEqual([
      'msgq consumer suspend\r',
      'msgq stat\r',
    ])
  })

  it('leaves the gap between lines, not before the first', async () => {
    vi.useFakeTimers()
    const term = fakeTerminal()
    registerTerminal(term)
    const done = typeLines(['one', 'two', 'three'], 150)

    expect(term.input).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(149)
    expect(term.input).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(term.input).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(150)
    expect(await done).toBe(true)
    expect(term.input).toHaveBeenCalledTimes(3)
  })

  it('stops when the terminal is replaced partway, as a restart does', async () => {
    vi.useFakeTimers()
    const first = fakeTerminal()
    const second = fakeTerminal()
    registerTerminal(first)
    const done = typeLines(['one', 'two'], 150)
    registerTerminal(second)
    await vi.advanceTimersByTimeAsync(150)

    expect(await done).toBe(false)
    expect(first.input).toHaveBeenCalledTimes(1)
    expect(second.input).not.toHaveBeenCalled()
  })
})

describe('waitForPrompt', () => {
  it('answers at once when the shell is idle at its prompt', async () => {
    registerTerminal(fakeTerminal('uart:~$ '))
    expect(await waitForPrompt(1000)).toBe(true)
  })

  it('waits for the prompt a shell prints once it has started', async () => {
    // A guest resumed early in boot: the shell has not started, and anything
    // typed now would be flushed by shell_start().
    const term = fakeTerminal('')
    registerTerminal(term)
    let ready: boolean | null = null
    void waitForPrompt(1000).then((value) => (ready = value))

    term.print('*** Booting Zephyr OS build 89987752c4af ***')
    await Promise.resolve()
    expect(ready).toBeNull()

    term.print('uart:~$ ')
    await Promise.resolve()
    expect(ready).toBe(true)
    expect(term.listening).toBe(0)
  })

  it('gives up after the timeout, and stops listening', async () => {
    vi.useFakeTimers()
    const term = fakeTerminal('my-prompt> ')
    registerTerminal(term)
    const ready = waitForPrompt(3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await ready).toBe(false)
    expect(term.listening).toBe(0)
  })

  it('has nothing to wait for with no terminal', async () => {
    expect(await waitForPrompt(1000)).toBe(false)
  })
})

describe('registerTerminal', () => {
  it('tells subscribers when a terminal comes and goes', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribe(() => seen.push(canType()))
    const term = fakeTerminal()
    registerTerminal(term)
    registerTerminal(term) // the same one again is not news
    registerTerminal(null)
    unsubscribe()
    expect(seen).toEqual([true, false])
  })
})
