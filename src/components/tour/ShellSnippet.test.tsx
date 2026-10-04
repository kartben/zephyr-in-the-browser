import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The snippet reads two things off the page: the debugger (thread walk, image
 * symbols, paused or not) and the tour (Continue). Both are faked here; the
 * terminal registry is the real one, handed a spy.
 */

const guest = vi.hoisted(() => ({
  paused: false,
  threads: [] as Array<{ name: string; addr: number }>,
  symbols: null as Map<string, { addr: number }> | null,
  listeners: new Set<() => void>(),
  /** Calls in the order they happened, across the fakes. */
  log: [] as string[],
}))

vi.mock('@/debug/control', () => ({
  subscribe: (fn: () => void) => {
    guest.listeners.add(fn)
    return () => guest.listeners.delete(fn)
  },
  getSnapshot: () => ({ paused: guest.paused, threads: guest.threads }),
  elfAddressSources: () => ({
    stacks: [],
    symbols: guest.symbols && { byAddr: [], byName: [], objects: guest.symbols },
  }),
}))

vi.mock('@/tours/store', () => ({
  next: () => guest.log.push('next'),
}))

const { ShellSnippet, continueAndRun } = await import('@/components/tour/ShellSnippet')
const { Markdown } = await import('@/components/Markdown')
const { registerTerminal } = await import('@/lib/terminalInput')

/** Publish a debugger change, the way hostGdb does when the guest resumes. */
function setPaused(paused: boolean) {
  guest.paused = paused
  for (const fn of guest.listeners) fn()
}

/** The terminal: its cursor line, and listeners for the guest printing. */
const screen = { line: 'uart:~$ ', parsed: new Set<() => void>() }

/** The guest printed, leaving the cursor at the end of `text`. */
function print(text: string) {
  screen.line = text
  for (const fn of [...screen.parsed]) fn()
}

const terminal = {
  input: vi.fn((data: string) => {
    guest.log.push(`type ${data}`)
  }),
  buffer: {
    active: {
      baseY: 0,
      cursorY: 0,
      get cursorX() {
        return screen.line.length
      },
      getLine: () => ({
        translateToString: (_trimRight?: boolean, start = 0, end?: number) =>
          screen.line.slice(start, end),
      }),
    },
  },
  onWriteParsed(listener: () => void) {
    screen.parsed.add(listener)
    return { dispose: () => void screen.parsed.delete(listener) }
  },
}

/** Every button's visible label, and whether it is disabled. */
function buttons(html: string): Array<{ label: string; disabled: boolean }> {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, inner]) => ({
    label: inner!.replace(/<[^>]+>/g, ''),
    disabled: / disabled=""/.test(attrs!),
  }))
}

/** The visible text, tags stripped. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

beforeEach(() => {
  guest.paused = false
  guest.threads = []
  guest.symbols = null
  guest.listeners.clear()
  guest.log = []
  screen.line = 'uart:~$ '
  screen.parsed.clear()
  terminal.input.mockClear()
  registerTerminal(terminal)
})

afterEach(() => {
  registerTerminal(null)
  vi.useRealTimers()
})

describe('ShellSnippet', () => {
  it('offers Run and Copy on a card the guest is running under', () => {
    const html = renderToStaticMarkup(<ShellSnippet lines={['msgq consumer suspend']} />)
    expect(text(html)).toContain('msgq consumer suspend')
    expect(buttons(html)).toEqual([
      { label: 'Run', disabled: false },
      { label: 'Copy', disabled: false },
    ])
  })

  it('says it resumes the guest on a paused card', () => {
    const html = renderToStaticMarkup(<ShellSnippet lines={['msgq stat']} paused />)
    expect(buttons(html)[0]).toEqual({ label: 'Continue and run', disabled: false })
  })

  it('shows the address a placeholder stands for', () => {
    guest.threads = [{ name: 'consumer', addr: 0x40062000 }]
    guest.symbols = new Map()
    const html = renderToStaticMarkup(
      <ShellSnippet lines={['kernel thread suspend ${thread:consumer}']} />,
    )
    expect(text(html)).toContain('kernel thread suspend 0x40062000')
    // The name the author wrote stays one hover away.
    expect(html).toContain('title="${thread:consumer}"')
    expect(buttons(html)[0]!.disabled).toBe(false)
  })

  it('disables Run and says why when a placeholder will not resolve', () => {
    guest.threads = [{ name: 'main', addr: 0x40061000 }]
    guest.symbols = new Map()
    const html = renderToStaticMarkup(
      <ShellSnippet lines={['kernel thread suspend ${thread:consumer}']} />,
    )
    expect(buttons(html)[0]).toEqual({ label: 'Run', disabled: true })
    expect(text(html)).toContain('No thread named “consumer”')
    // Copy still works: it is the way out when Run cannot help.
    expect(buttons(html)[1]).toEqual({ label: 'Copy', disabled: false })
  })

  it('does not invent an address with no guest underneath', () => {
    const html = renderToStaticMarkup(<ShellSnippet lines={['devmem ${addr:readings}']} />)
    expect(buttons(html)[0]!.disabled).toBe(true)
    expect(text(html)).toContain('${addr:readings} needs the running guest')
  })

  it('disables Run with no terminal to type into', () => {
    registerTerminal(null)
    const html = renderToStaticMarkup(<ShellSnippet lines={['msgq stat']} />)
    expect(buttons(html)[0]!.disabled).toBe(true)
    expect(text(html)).toContain('No terminal to type into')
  })
})

describe('Markdown', () => {
  const body = (language: string) => `Stop the consumer:\n\n\`\`\`${language}\nmsgq consumer suspend\n\`\`\``

  it('makes a shell fence runnable in a tour card', () => {
    const html = renderToStaticMarkup(<Markdown body={body('shell')} runnable />)
    expect(buttons(html).map((b) => b.label)).toEqual(['Run', 'Copy'])
  })

  it('leaves sh and console fences inert', () => {
    for (const language of ['sh', 'console', 'c', '']) {
      const html = renderToStaticMarkup(<Markdown body={body(language)} runnable />)
      expect(buttons(html), language).toEqual([])
      expect(text(html)).toContain('msgq consumer suspend')
    }
  })

  it('leaves Markdown outside a tour card inert', () => {
    expect(buttons(renderToStaticMarkup(<Markdown body={body('shell')} />))).toEqual([])
  })
})

describe('continueAndRun', () => {
  it('resumes the guest first, and types once it reports running', async () => {
    guest.paused = true
    const done = continueAndRun(['msgq consumer suspend', 'msgq stat'])
    await Promise.resolve()
    // Continue went out, and nothing is typed into a halted guest.
    expect(guest.log).toEqual(['next'])

    setPaused(false)
    expect(await done).toBe(true)
    expect(guest.log).toEqual(['next', 'type msgq consumer suspend\r', 'type msgq stat\r'])
  })

  it('waits for the shell to start when the card paused before it did', async () => {
    // Paused in main(): the shell has not printed its prompt yet, and it
    // flushes whatever arrives before it does.
    screen.line = ''
    guest.paused = true
    const done = continueAndRun(['kernel version'])
    setPaused(false)
    await Promise.resolve()
    print('*** Booting Zephyr OS build 89987752c4af ***')
    await Promise.resolve()
    expect(guest.log).toEqual(['next'])

    print('uart:~$ ')
    expect(await done).toBe(true)
    expect(guest.log).toEqual(['next', 'type kernel version\r'])
  })

  it('types anyway if the guest never reports running', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    guest.paused = true
    const done = continueAndRun(['msgq stat'], { resumeMs: 2000 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(guest.log).toEqual(['next'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toBe(true)
    // The command waits in the terminal's input until the guest gets to it.
    expect(guest.log).toEqual(['next', 'type msgq stat\r'])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('types anyway if no prompt ever shows', async () => {
    vi.useFakeTimers()
    screen.line = 'my-prompt> '
    const done = continueAndRun(['msgq stat'], { promptMs: 3000 })
    await vi.advanceTimersByTimeAsync(2999)
    expect(guest.log).toEqual(['next'])
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toBe(true)
    expect(guest.log).toEqual(['next', 'type msgq stat\r'])
  })
})
