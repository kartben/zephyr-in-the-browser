import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROW_IS_STMT, ROW_PROLOGUE_END, type LineIndex } from '@/debug/dwarfLines'

/*
 * The engine's job is to decide which stop belongs to which step and what
 * happens to the machine afterwards, so the debugger is the thing to fake. The
 * two mocks below stand in for the gdb session (registers, symbols, memory)
 * and for the run-control façade the store drives.
 */

let paused = false
let pc = '00008004'
const breakpoints = new Set<number>()
const resumed: number[] = []
let gdbListeners: Array<() => void> = []
/** The store's stop filter, as hostGdb would hold it. */
let stopFilter: ((pc: string) => boolean) | null = null
/** Hits the filter waved through without ever publishing a pause. */
const swallowed: string[] = []
/** The image, for the tests that need a line table; see `msgqLines`. */
let kernelElf: Uint8Array | null = null
/** Guest bytes a test has set; anything else reads as its address's low byte. */
const memory = new Map<number, number>()

const gdbSnapshot = () => ({
  attached: true,
  paused,
  pc,
  registers: 'PC=00008004\nSP=20001000\nX00=00002000',
  registersLoading: false,
  regArch: 'aarch64' as const,
})

vi.mock('@/hostGdb', () => ({
  subscribe: (fn: () => void) => {
    gdbListeners.push(fn)
    return () => {
      gdbListeners = gdbListeners.filter((f) => f !== fn)
    }
  },
  getSnapshot: () => gdbSnapshot(),
  getKernelElf: () => kernelElf,
  getSymbolIndex: () => ({
    byAddr: [
      { name: 'main', addr: 0x8000, size: 0x40 },
      { name: 'z_impl_k_msgq_put', addr: 0x10000, size: 0x20 },
    ],
    byName: [
      { name: 'main', addr: 0x8000, size: 0x40 },
      { name: 'z_impl_k_msgq_put', addr: 0x10000, size: 0x20 },
    ],
    objects: new Map([
      ['led', { name: 'led', addr: 0x2000, size: 8 }],
      ['z_interrupt_stacks', { name: 'z_interrupt_stacks', addr: 0x2000_0000, size: 0x2000 }],
      ['alarms_lost', { name: 'alarms_lost', addr: 0x3000, size: 4 }],
    ]),
  }),
  setAttachHook: () => {},
  setStopFilter: (fn: ((pc: string) => boolean) | null) => {
    stopFilter = fn
  },
  sessionActive: () => true,
}))

vi.mock('@/debug/control', () => ({
  subscribe: () => () => {},
  getSnapshot: () => ({ paused }),
  addBreakpoint: async (addr: number) => {
    breakpoints.add(addr)
    return true
  },
  removeBreakpoint: async (addr: number) => {
    breakpoints.delete(addr)
    return true
  },
  readMemory: async () => null,
  readMemoryRaw: async (addr: number, length: number) =>
    Uint8Array.from({ length }, (_, i) => memory.get(addr + i) ?? addr & 0xff),
  resume: () => {
    resumed.push(Date.now())
    paused = false
    // The real hostGdb republishes on resume, which is what lets the store see
    // the *next* stop as a new one rather than the same one twice.
    for (const fn of gdbListeners) fn()
  },
}))

/*
 * Tours are bundled with the page rather than fetched, so this is what stands
 * in for the glob — the store asks for a sample id, not a URL.
 */
const tourText = vi.hoisted(() => ({ body: '' }))

vi.mock('@/tours/catalog', () => ({
  loadTourSource: async (id: string) => (id.startsWith('tour-') ? tourText.body : null),
  hasTour: () => true,
  tourIds: () => ['tour'],
  baseSampleId: (id: string) => id.replace(/_trace$/, ''),
}))

/** Panel kinds and instrument row keys the step revealed, in order. */
const revealed: string[] = []
vi.mock('@/lib/dockReveal', () => ({
  revealPanelKind: (kind: string) => revealed.push(kind),
  revealDockRow: (key: string) => revealed.push(key),
}))

/*
 * The real line-table lookups, over a hand-built table: parsing one out of an
 * ELF is dwarfLines.test.ts's business. Only reached once a test sets
 * `kernelElf`, so the tours above never see it.
 */
vi.mock('@/debug/dwarfLines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/debug/dwarfLines')>()),
  buildLineIndex: () => msgqLines(),
}))

const {
  arm,
  dismissCompletion,
  getSnapshot,
  getSteps,
  loadFor,
  next,
  reset,
  revisit,
  skip,
  startDemo,
} = await import('@/tours/store')

/** Two steps on the same address, plus one of its own. */
const TOUR = `---
tour: Test tour
sample: samples/basic/blinky
---

## First pass through the loop

\`\`\`tour
at: main
when: first
panel: led
watch:
  - pin = led as u8
\`\`\`

Prose.

## Every fourth pass

\`\`\`tour
at: main
when: hits % 4 == 0
repeat: yes
stop: no
\`\`\`

Prose.

## Somewhere else entirely

\`\`\`tour
at: 0x9000
\`\`\`

Prose.
`

/** Let the plant-then-resume chain in next() finish. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Deliver a stop at `addr`, the way hostGdb would: read the PC, offer it to the
 * filter, and only publish a pause for the stops the filter keeps. A rejected
 * one is continued without the guest ever appearing stopped, which is the whole
 * reason `when:` can sit on a hot breakpoint.
 */
async function stopAt(addr: number) {
  const hex = addr.toString(16).padStart(8, '0')
  if (stopFilter?.(hex)) {
    swallowed.push(hex)
    return
  }
  paused = true
  pc = hex
  for (const fn of gdbListeners) fn()
  // Let the card's memory reads settle.
  await new Promise((r) => setTimeout(r, 0))
}

let url = 0

beforeEach(async () => {
  reset()
  paused = false
  breakpoints.clear()
  resumed.length = 0
  revealed.length = 0
  swallowed.length = 0
  memory.clear()
  stopFilter = null
  tourText.body = TOUR
  // A fresh id each time: the tour cache is keyed by it, deliberately.
  await loadFor(`tour-${url++}`)
  await arm()
})

describe('arming', () => {
  it('resolves every step but plants only the one being waited on', () => {
    // All three resolve — `main` through symbols, 0x9000 as a raw address —
    // but a breakpoint is a trap on every pass, so only the first goes in.
    expect(getSteps().every((s) => s.anchor !== null)).toBe(true)
    expect([...breakpoints]).toEqual([0x8000])
    expect(getSnapshot().armed).toBe(true)
    expect(getSnapshot().problems).toEqual([])
  })

  it('plants the next step before resuming, not after', async () => {
    await stopAt(0x8000) // step 1
    next()
    await settle()
    // Step 2 shares step 1's address, so that one stays; the resume must not
    // have happened before the plant, or the guest outruns the tour.
    expect(breakpoints.has(0x8000)).toBe(true)
    expect(resumed).toHaveLength(1)
  })
})

describe('stops', () => {
  it('ignores a stop that belongs to nobody', async () => {
    await stopAt(0x1234)
    expect(getSnapshot().current).toBeNull()
    expect(swallowed).toHaveLength(0) // not ours to swallow — Pause must work
    expect(resumed).toHaveLength(0)
  })

  it('shows the step whose condition fires, and reveals its panel', async () => {
    await stopAt(0x8000)
    const card = getSnapshot().current
    expect(card?.step.title).toBe('First pass through the loop')
    expect(card?.paused).toBe(true)
    expect(card?.values[0]).toMatchObject({ label: 'pin', ok: true })
    expect(revealed).toEqual(['led'])
    // A stopping step leaves the machine stopped until the reader continues.
    expect(resumed).toHaveLength(0)
  })

  it('lifts the breakpoint only when no other step still wants the address', async () => {
    await stopAt(0x8000)
    next()
    await settle()
    // Step 2 shares the address and repeats, so the breakpoint stays.
    expect(breakpoints.has(0x8000)).toBe(true)
    expect(getSteps()[0]!.planted).toBe(false)
    expect(getSteps()[1]!.planted).toBe(true)
  })

  it('slips past hits no step asked for, without ever pausing', async () => {
    await stopAt(0x8000)
    next() // step 1 fires and is done
    await settle()
    await stopAt(0x8000) // hit 2 — step 2 wants every fourth
    expect(getSnapshot().current).toBeNull()
    // The rejected hit never reached the expensive path: no pause published,
    // no thread walk, and the store did not have to resume anything.
    expect(swallowed).toEqual(['00008000'])
    expect(resumed).toHaveLength(1) // just the `next()` above
    expect(paused).toBe(false)
  })

  it('does not spend a step\'s hits while another card is up', async () => {
    await stopAt(0x8000) // step 1 fires, card up, machine stopped
    await stopAt(0x8000) // could not happen while stopped, but must be safe
    expect(swallowed).toEqual(['00008000'])
    expect(getSteps()[1]!.hits).toBe(1) // not counted a second time
  })

  it('fires the repeating step on its hit and runs on when `stop: no`', async () => {
    await stopAt(0x8000)
    next()
    await settle()
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000) // hit 4
    expect(swallowed).toHaveLength(2) // hits 2 and 3 cost nothing
    const card = getSnapshot().current
    expect(card?.step.title).toBe('Every fourth pass')
    expect(card?.paused).toBe(false)
    // `stop: no` means the card goes up and the machine keeps going.
    expect(resumed.length).toBeGreaterThan(0)
    expect(paused).toBe(false)
  })

  it('counts a step as seen so the outline can offer it again', async () => {
    await stopAt(0x8000)
    expect([...getSnapshot().seen]).toEqual([0])
  })

  it('opens the views a firing step looks at, and says which it cannot', async () => {
    reset()
    tourText.body = `---
tour: Look test
sample: samples/kernel/msg_queue
---

## The queue fills

\`\`\`tour
at: main
look:
  - dock.gpio
  - debug.objects
  - trace.queues
\`\`\`

Prose.
`
    await loadFor(`tour-${url++}`)
    await arm()
    await stopAt(0x8000)
    // This guest writes no trace and its sample does not name Trace, so the
    // Queues tab has nowhere to open: the card says so instead.
    expect(revealed).toEqual(['gpio', 'stage:debug'])
    expect(getSnapshot().current?.lookNotes).toEqual([
      'This view needs the traced build of this sample.',
    ])
  })

  it('leaves a card that looks at nothing without notes', async () => {
    await stopAt(0x8000)
    expect(getSnapshot().current?.lookNotes).toEqual([])
  })

  it('names an address inside a data object, as it does one inside a function', async () => {
    // The stack pointer sits in `z_interrupt_stacks`; it used to read as a bare
    // address because only functions were ever looked up, and the name that was
    // found only went to `detail`, which the card does not show.
    reset()
    tourText.body = `## Where the stack is

\`\`\`tour
at: main
watch:
  - stack = $sp as addr
  - stopped in = $pc as code
\`\`\`

Prose.
`
    await loadFor(`tour-${url++}`)
    await arm()
    await stopAt(0x8000)
    expect(getSnapshot().current?.values).toMatchObject([
      { label: 'stack', text: '0x20001000 · z_interrupt_stacks+0x1000' },
      { label: 'stopped in', text: 'main+0x4' },
    ])
  })
})

describe('leaving', () => {
  it('drops every breakpoint and resumes', async () => {
    await stopAt(0x8000)
    skip()
    await settle()
    expect(breakpoints.size).toBe(0)
    expect(getSnapshot().finished).toBe(true)
    expect(getSnapshot().current).toBeNull()
  })

  it('on finish clears leftover breakpoints so the guest free-runs', async () => {
    await stopAt(0x8000) // step 1
    next()
    await settle()
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000) // step 2 (repeat, stop: no) — leaves its BP planted
    next()
    await settle()
    await stopAt(0x9000) // step 3
    expect(getSnapshot().current?.paused).toBe(true)
    // Repeating step 2 still wants 0x8000 until the tour is over.
    expect(breakpoints.has(0x8000)).toBe(true)
    expect(stopFilter).not.toBeNull()
    next()
    await settle()
    expect(breakpoints.size).toBe(0)
    expect(stopFilter).toBeNull()
    expect(getSnapshot().finished).toBe(true)
    expect(getSnapshot().armed).toBe(false)
    expect(getSnapshot().current).toBeNull()
    expect(paused).toBe(false)
  })

  it('Got it on a final stop: no step clears that breakpoint and leaves the guest running', async () => {
    // Blinky's last card says "Got it" (`stop: no`). The breakpoint it just
    // hit has to be gone before the guest is let go, or the next pass stops
    // the LED again. Leave the tour already did this; finishing must too.
    reset()
    tourText.body = `---
tour: Blinky shape
sample: samples/basic/blinky
---

## The stop

\`\`\`tour
at: 0x8000
when: first
\`\`\`

Prose.

## Keep going

\`\`\`tour
at: 0x9000
when: first
stop: no
\`\`\`

Prose.
`
    await loadFor(`tour-${url++}`)
    await arm()
    await stopAt(0x8000)
    next()
    await settle()
    await stopAt(0x9000)
    expect(getSnapshot().current?.paused).toBe(false)
    expect(breakpoints.has(0x9000)).toBe(false)
    expect(paused).toBe(false)
    next()
    await settle()
    expect(breakpoints.size).toBe(0)
    expect(stopFilter).toBeNull()
    expect(getSnapshot().finished).toBe(true)
    expect(paused).toBe(false)
  })

  it('Leave the tour awaits disarm before resume so a leftover BP cannot re-trap', async () => {
    await stopAt(0x8000)
    expect(breakpoints.size).toBeGreaterThan(0)
    expect(paused).toBe(true)
    skip()
    await settle()
    expect(breakpoints.size).toBe(0)
    expect(stopFilter).toBeNull()
    expect(getSnapshot().finished).toBe(true)
    expect(getSnapshot().current).toBeNull()
    expect(paused).toBe(false)
  })
})

/** Ends on an outro and chains on; its second step waits on the reader. */
const LIFECYCLE = `---
tour: Lifecycle
sample: samples/basic/button
next: blinky
---

## Main waits

\`\`\`tour
at: 0x8000
\`\`\`

Prose.

## A press arrives

\`\`\`tour
at: 0x9000
panel: keys
await: Press **SW0** in the dock.
do:
  - kernel uptime
\`\`\`

Prose.

## What you saw

The press went through the input subsystem.
`

async function loadLifecycle(body = LIFECYCLE) {
  reset()
  tourText.body = body
  await loadFor(`tour-${url++}`)
  await arm()
}

describe("the reader's turn", () => {
  beforeEach(() => loadLifecycle())

  it('says what to do once the card before it goes, and gives way when the step fires', async () => {
    expect(getSnapshot().waiting).toBeNull() // step 1 asks nothing of the reader
    await stopAt(0x8000)
    next()
    await settle()
    expect(getSnapshot().current).toBeNull()
    expect(getSnapshot().waiting).toEqual({
      index: 1,
      text: 'Press **SW0** in the dock.',
      do: ['kernel uptime'],
      notes: [],
    })
    // The reader can only do it with the guest running, and where they are to
    // do it is open before the step fires, not after.
    expect(paused).toBe(false)
    expect(breakpoints.has(0x9000)).toBe(true)
    expect(revealed).toEqual(['keys'])

    await stopAt(0x9000)
    expect(getSnapshot().waiting).toBeNull()
    expect(getSnapshot().current?.step.title).toBe('A press arrives')
  })

  it('asks from the start when the very first step waits on the reader', async () => {
    await loadLifecycle(LIFECYCLE.replace('at: 0x8000\n', 'at: 0x8000\nawait: Watch the terminal.\n'))
    expect(getSnapshot().waiting).toEqual({ index: 0, text: 'Watch the terminal.', do: [], notes: [] })
  })

  it('comes back after reading an earlier step again', async () => {
    await stopAt(0x8000)
    next()
    await settle()
    revisit(0)
    expect(getSnapshot().current?.step.index).toBe(0)
    next()
    await settle()
    expect(getSnapshot().waiting?.index).toBe(1)
  })
})

describe('ending', () => {
  beforeEach(() => loadLifecycle())

  async function walk() {
    await stopAt(0x8000)
    next()
    await settle()
    await stopAt(0x9000)
    next()
    await settle()
  }

  it('is complete once every step has had its turn', async () => {
    await walk()
    expect(getSnapshot()).toMatchObject({
      finished: true,
      completed: true,
      current: null,
      waiting: null,
    })
    expect(getSnapshot().doc?.outro?.title).toBe('What you saw')
    expect(breakpoints.size).toBe(0)
  })

  it('is not complete when the reader leaves, even from the your-turn card', async () => {
    await stopAt(0x8000)
    next()
    await settle()
    expect(getSnapshot().waiting).not.toBeNull()
    skip()
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: false, waiting: null })
    expect(breakpoints.size).toBe(0)
  })

  it('closes the completion card and leaves the rest alone', async () => {
    await walk()
    dismissCompletion()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: false, armed: false })
  })
})

/**
 * The lost-alarm finale in miniature: a step that checks a counter and an
 * argument, retries until the counter is right, then one more step and an
 * outro.
 */
const CHECKED = `---
tour: Checks
sample: samples/kernel/msg_queue
---

## The alarm goes in

\`\`\`tour
at: 0x8000
await: Pick a policy, then press **SW0** again.
check:
  - alarms_lost as u32 == 0
  - $arg0 == led
pass: The alarm got through.
fail: Another alarm was lost.
retry: yes
\`\`\`

Prose.

## Afterwards

\`\`\`tour
at: 0x9000
\`\`\`

Prose.

## What you saw

Prose.
`

describe('checks', () => {
  /** `alarms_lost`, as the guest has it at the next stop. */
  function lost(count: number) {
    ;[count, 0, 0, 0].forEach((byte, i) => memory.set(0x3000 + i, byte))
  }

  /**
   * Load a tour and let it arm once, the way attaching the stub does. (The
   * other suites arm twice, which plants a second step ahead of the first.)
   */
  async function loadChecked(body = CHECKED) {
    reset()
    tourText.body = body
    await loadFor(`tour-${url++}`) // the session is up, so this arms
    await settle()
  }

  beforeEach(() => loadChecked())

  it('puts the verdict on the card, with what the guest had for each side read', async () => {
    lost(2)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check).toEqual({
      rows: [
        {
          text: 'alarms_lost as u32 == 0',
          pass: false,
          values: [{ expr: 'alarms_lost', text: '2', ok: true }],
        },
        {
          text: '$arg0 == led',
          pass: true,
          values: [
            { expr: '$arg0', text: '8192 · 0x2000', ok: true },
            { expr: 'led', text: '8192 · 0x2000', ok: true },
          ],
        },
      ],
      outcome: 'failed',
      retrying: true,
    })
  })

  it('keeps a failing retry step armed, holds the tour on it, and fires it again', async () => {
    lost(1)
    await stopAt(0x8000)
    next()
    await settle()
    // The reader is trying again: the guest runs, the same step waits for the
    // next hit, and the step after it is not planted to jump in first.
    expect(paused).toBe(false)
    expect([...breakpoints]).toEqual([0x8000])
    expect(getSnapshot()).toMatchObject({ finished: false, completed: false, armed: true })
    expect(getSnapshot().waiting?.text).toBe('Pick a policy, then press **SW0** again.')

    await stopAt(0x8000)
    expect(getSnapshot().current?.step.title).toBe('The alarm goes in')
    expect(getSnapshot().current?.check?.outcome).toBe('failed')
  })

  it('lifts the breakpoint and moves on once the checks pass', async () => {
    lost(1)
    await stopAt(0x8000)
    next()
    await settle()
    lost(0)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check).toMatchObject({ outcome: 'passed', retrying: false })
    expect(breakpoints.has(0x8000)).toBe(false)
    next()
    await settle()
    expect([...breakpoints]).toEqual([0x9000])
    expect(getSnapshot().waiting).toBeNull()
  })

  it('counts each try from its first hit, so `when: first` means the next one', async () => {
    await loadChecked(CHECKED.replace('at: 0x8000\n', 'at: 0x8000\nwhen: first\n'))
    lost(1)
    await stopAt(0x8000)
    expect(getSteps()[0]!.hits).toBe(0)
    next()
    await settle()
    await stopAt(0x8000)
    expect(swallowed).toEqual([])
    expect(getSnapshot().current?.hits).toBe(1)
  })

  it('cannot complete the tour while a retry step is failing', async () => {
    await loadChecked(CHECKED.replace(/## Afterwards[\s\S]*?Prose\.\n\n/, ''))
    lost(3)
    await stopAt(0x8000)
    next()
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: false, completed: false })
    lost(0)
    await stopAt(0x8000)
    next()
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: true })
    expect(breakpoints.size).toBe(0)
  })

  it('shows a failure and moves on when the step does not retry', async () => {
    await loadChecked(CHECKED.replace('retry: yes\n', ''))
    lost(1)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check).toMatchObject({ outcome: 'failed', retrying: false })
    next()
    await settle()
    expect([...breakpoints]).toEqual([0x9000])
    await stopAt(0x9000)
    next()
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: true })
  })

  it('does not pass a check it could not read', async () => {
    await loadChecked(CHECKED.replace('alarms_lost as u32 == 0', 'nope as u32 == 0'))
    await stopAt(0x8000)
    expect(getSnapshot().current?.check?.rows[0]).toEqual({
      text: 'nope as u32 == 0',
      pass: null,
      values: [{ expr: 'nope', text: 'no symbol `nope`', ok: false }],
    })
    expect(getSnapshot().current?.check).toMatchObject({ outcome: 'unknown', retrying: true })
    next()
    await settle()
    expect([...breakpoints]).toEqual([0x8000])
  })

  it('holds a later step planted ahead of time until the retry passes', async () => {
    // Arming twice plants step 2 alongside step 1, as a `stop: no` step before
    // a retry can. Its hits during the retry are not its turn.
    await loadLifecycle(CHECKED)
    expect(breakpoints.has(0x9000)).toBe(true)
    lost(1)
    await stopAt(0x8000)
    next()
    await settle()
    await stopAt(0x9000)
    expect(swallowed).toEqual(['00009000'])
    expect(getSnapshot().current).toBeNull()
    expect(getSteps()[1]!.hits).toBe(0)
    lost(0)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check?.outcome).toBe('passed')
    next()
    await settle()
    await stopAt(0x9000)
    expect(getSnapshot().current?.step.title).toBe('Afterwards')
  })

  it('leaves a step with no checks without a verdict', async () => {
    await loadChecked(LIFECYCLE)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check).toBeNull()
  })
})

describe('the mock replay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** What the reader would see after each beat of the replay. */
  async function beats(count: number, between?: () => void): Promise<string[]> {
    const seen: string[] = []
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(3200)
      const s = getSnapshot()
      seen.push(
        s.current
          ? s.current.step.title
          : s.waiting
            ? `your turn: ${s.waiting.index + 1}`
            : s.completed
              ? 'complete'
              : 'nothing',
      )
      if (i === 0) between?.()
    }
    return seen
  }

  async function replay(body: string) {
    reset()
    tourText.body = body
    vi.useFakeTimers()
    const ac = new AbortController()
    startDemo(`tour-${url++}`, ac.signal)
    await vi.advanceTimersByTimeAsync(0) // the tour loads
    return ac
  }

  it('gives a waiting step a beat of its own, then ends on the outro', async () => {
    const ac = await replay(LIFECYCLE)
    expect(await beats(5)).toEqual([
      'Main waits',
      'your turn: 2',
      'A press arrives',
      'complete',
      'complete',
    ])
    ac.abort()
  })

  it('shows a check as not checked, and moves on', async () => {
    const ac = await replay(CHECKED)
    expect(await beats(4)).toEqual([
      'your turn: 1',
      'The alarm goes in',
      'Afterwards',
      'complete',
    ])
    const check = getSteps()[0]!.card?.check
    // Nothing was read, so the card claims neither verdict, and a replay on a
    // timer cannot wait for a pass that will never come.
    expect(check).toEqual({
      rows: [
        { text: 'alarms_lost as u32 == 0', pass: null, values: [] },
        { text: '$arg0 == led', pass: null, values: [] },
      ],
      outcome: 'unknown',
      retrying: false,
    })
    ac.abort()
  })

  it('stops when the reader leaves, and never calls that complete', async () => {
    const ac = await replay(LIFECYCLE)
    expect(await beats(4, skip)).toEqual(['Main waits', 'nothing', 'nothing', 'nothing'])
    expect(getSnapshot()).toMatchObject({ finished: true, completed: false })
    ac.abort()
  })
})

/* ------------------------------------------------------------------ *
 * Stops outside the sample
 * ------------------------------------------------------------------ */

/** Where the build machine kept the kernel, as DWARF recorded it. */
const MSGQ_DWARF = '/workdir/zephyr/kernel/msg_q.c'

/** Three rows of kernel/msg_q.c: z_impl_k_msgq_put, and the hand-off inside it. */
function msgqLines(): LineIndex {
  const rows = [
    { addr: 0x10000, line: 252, flags: ROW_IS_STMT },
    { addr: 0x10004, line: 253, flags: ROW_IS_STMT | ROW_PROLOGUE_END },
    { addr: 0x10010, line: 172, flags: ROW_IS_STMT },
  ]
  return {
    addrs: new Float64Array(rows.map((r) => r.addr)),
    lines: new Int32Array(rows.map((r) => r.line)),
    fileIds: new Int32Array(rows.map(() => 0)),
    flags: new Uint8Array(rows.map((r) => r.flags)),
    files: [MSGQ_DWARF],
    baseNames: ['msg_q.c'],
  }
}

/** Enough of msg_q.c for the anchor and the highlight to land where they do upstream. */
const MSGQ_C = Array.from({ length: 260 }, (_, i) => `/* line ${i + 1} */`)
MSGQ_C[168] = '\t\t\tpending_thread = z_unpend_first_thread_locked(&msgq->wait_q);'
MSGQ_C[170] = "\t\t\t\t/* copy into the receiver's buffer */"
MSGQ_C[171] = '\t\t\t\t(void)memcpy(pending_thread->base.swap_data, data,'
MSGQ_C[250] = 'int z_impl_k_msgq_put(struct k_msgq *msgq, const void *data, k_timeout_t timeout)'

const MSGQ_TOUR = `---
tour: Message queues
sample: samples/kernel/msg_queue
sources:
  - kernel/msg_q.c
---

## The hand-off

\`\`\`tour
at: msg_q.c:/copy into the receiver's buffer/ | z_impl_k_msgq_put
highlight: /pending_thread = z_unpend_first_thread_locked/ + 8
\`\`\`

Prose.
`

const SHIPPED = '/qemu/zephyr/qemu_cortex_a53/src/msg_queue/'

describe('stops outside the sample', () => {
  const fetched: string[] = []

  /** Answer like the dev server: unknown paths get index.html and a 200. */
  function serve(files: Record<string, string>) {
    fetched.length = 0
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      const body = files[url.slice(SHIPPED.length)]
      if (body === undefined) {
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
      }
      const type = url.endsWith('.json') ? 'application/json' : 'text/plain'
      return new Response(body, { headers: { 'content-type': type } })
    })
  }

  async function loadMsgq() {
    reset()
    kernelElf = new Uint8Array(1)
    tourText.body = MSGQ_TOUR
    await loadFor(`tour-${url++}`, (file) => `${SHIPPED}${file}`)
    await arm()
  }

  afterEach(() => {
    kernelElf = null
    vi.unstubAllGlobals()
  })

  it('resolves a pattern in a kernel file through the image’s index', async () => {
    serve({
      'index.json': JSON.stringify({ files: ['main.c', 'zephyr/kernel/msg_q.c'] }),
      'zephyr/kernel/msg_q.c': MSGQ_C.join('\n'),
    })
    await loadMsgq()

    expect(getSnapshot().problems).toEqual([])
    expect(getSteps()[0]!.anchor).toMatchObject({
      via: 'pattern',
      addr: 0x10010,
      file: MSGQ_DWARF,
      line: 172,
    })
    expect(fetched).toContain(`${SHIPPED}zephyr/kernel/msg_q.c`)

    await stopAt(0x10010)
    const card = getSnapshot().current
    expect(card?.source).toBe('zephyr/kernel/msg_q.c')
    expect(card?.provenance).toEqual({ origin: 'Zephyr kernel', path: 'kernel/msg_q.c' })
    expect(card?.highlight).toEqual([{ start: 169, end: 177 }])
  })

  it('on an image with no index, falls back as it always has', async () => {
    // Shipped before there was an index: the sample's own files, and no kernel.
    serve({ 'main.c': 'int main(void) { return 0; }' })
    await loadMsgq()

    // The pattern cannot be searched, so the next alternative wins.
    expect(getSteps()[0]!.anchor).toMatchObject({ via: 'symbol', addr: 0x10004, line: 253 })
    expect(fetched).not.toContain(`${SHIPPED}zephyr/kernel/msg_q.c`)

    await stopAt(0x10004)
    const card = getSnapshot().current
    // The basename guess the card has always made, which finds nothing here.
    expect(card?.source).toBe('msg_q.c')
    expect(card?.provenance).toBeNull()
    expect(card?.highlight).toEqual([])
  })

  it('shows no excerpt for a kernel file the image did not ship', async () => {
    serve({ 'index.json': JSON.stringify({ files: ['main.c'] }) })
    await loadMsgq()

    expect(getSteps()[0]!.anchor).toMatchObject({ via: 'symbol', addr: 0x10004 })
    await stopAt(0x10004)
    expect(getSnapshot().current?.source).toBeNull()
    expect(getSnapshot().current?.provenance).toBeNull()
  })
})
