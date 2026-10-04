import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROW_IS_STMT, ROW_PROLOGUE_END, type LineIndex } from '@/debug/dwarfLines'
import type { StopFilter } from '@/hostGdb'

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
let stopFilter: StopFilter | null = null
/** Hits the filter waved through without ever publishing a pause. */
const swallowed: string[] = []
/** The image, for the tests that need a line table or DWARF; see `msgqLines`. */
let kernelElf: Uint8Array | null = null
/** Guest bytes a test has set; anything else reads as its address's low byte. */
const memory = new Map<number, number>()
/** Guest memory as a stop's own `read` sees it, by exact address. */
const stopMemory = new Map<number, Uint8Array>()
/** Addresses the filter read at a stop, before anything was published. */
const filterReads: number[] = []
/** While set, a stop's reads wait on it: the guest taking its time to answer. */
let readGate: Promise<void> | null = null
/** How many times the store walked the DWARF for a struct layout. */
const dwarf = vi.hoisted(() => ({ walks: 0 }))

vi.mock('@/debug/dwarfMembers', () => ({
  dwarfStructMembers: (_elf: Uint8Array, name: string) => {
    dwarf.walks++
    return name === 'k_msgq' ? { wait_q: 0, used_msgs: 0x20 } : {}
  },
}))

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
      ['readings', { name: 'readings', addr: 0x4400, size: 0x48 }],
      ['counter', { name: 'counter', addr: 0x4500, size: 4 }],
    ]),
  }),
  setAttachHook: () => {},
  setStopFilter: (fn: StopFilter | null) => {
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

/**
 * Blinky's shape: a note the guest runs on under, then two stops round its
 * loop. Every step has an address of its own, so the breakpoints that are in
 * say which steps are planted.
 */
const RUN_ON = `---
tour: Run on
sample: samples/basic/blinky
---

## Configure the pin

\`\`\`tour
at: 0x8000
stop: no
\`\`\`

Prose.

## Toggle it

\`\`\`tour
at: 0x9000
\`\`\`

Prose.

## Sleep

\`\`\`tour
at: 0xa000
\`\`\`

Prose.
`

/** Let the plant-then-resume chain in next() finish. */
async function settle() {
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Deliver a stop at `addr`, the way hostGdb would: read the registers, offer
 * the stop to the filter, and only publish a pause for the stops the filter
 * keeps. A rejected one is continued without the guest ever appearing stopped,
 * which is the whole reason `when:` can sit on a hot breakpoint.
 */
async function stopAt(addr: number, registers = 'PC=00008000\nX00=00002000') {
  const hex = addr.toString(16).padStart(8, '0')
  const reject = await stopFilter?.({
    pc: hex,
    registers,
    async read(at, length) {
      filterReads.push(at)
      if (readGate) await readGate
      return stopMemory.get(at)?.slice(0, length) ?? null
    },
  })
  if (reject) {
    swallowed.push(hex)
    return
  }
  paused = true
  pc = hex
  for (const fn of gdbListeners) fn()
  // Let the card's memory reads settle.
  await new Promise((r) => setTimeout(r, 0))
}

/** The guest runs over `addr`, and only stops there if a breakpoint is in. */
async function pass(addr: number) {
  if (breakpoints.has(addr)) await stopAt(addr)
}

/** Indexes of the steps whose breakpoint is in. */
function planted(): number[] {
  return getSteps()
    .filter((s) => s.planted)
    .map((s) => s.step.index)
}

let url = 0

/** Load a tour and let it arm once, the way attaching the stub does. */
async function loadOnce(body: string) {
  reset()
  tourText.body = body
  await loadFor(`tour-${url++}`) // the session is up, so this arms
  await settle()
}

beforeEach(async () => {
  reset()
  paused = false
  breakpoints.clear()
  resumed.length = 0
  revealed.length = 0
  swallowed.length = 0
  memory.clear()
  stopMemory.clear()
  filterReads.length = 0
  readGate = null
  dwarf.walks = 0
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
    // Armed twice (loadFor, then arm), as a second attach would: step 2 shares
    // the address, but it is not its turn.
    expect(planted()).toEqual([0])
    expect(getSnapshot().armed).toBe(true)
    expect(getSnapshot().problems).toEqual([])
  })

  it('plants the next step before resuming, not after', async () => {
    await stopAt(0x8000) // step 1
    next()
    await settle()
    // Step 1's breakpoint came out as it fired, and went back in for step 2,
    // which shares the address. The resume must not have happened before the
    // plant, or the guest outruns the tour.
    expect(breakpoints.has(0x8000)).toBe(true)
    expect(resumed).toHaveLength(1)
  })
})

describe('one breakpoint at a time', () => {
  beforeEach(() => loadOnce(RUN_ON))

  it('plants nothing more on Got it, since a `stop: no` step plants the next itself', async () => {
    await pass(0x8000)
    // The card stays up, and the guest runs on towards step 2, planted first.
    expect(getSnapshot().current?.step.index).toBe(0)
    expect(planted()).toEqual([1])
    next() // Got it
    await settle()
    expect(planted()).toEqual([1])
    expect([...breakpoints]).toEqual([0x9000])
    // The guest goes by step 3's line first. Not its turn, so no stop there.
    await pass(0xa000)
    expect(getSnapshot().current).toBeNull()
    await pass(0x9000)
    expect(getSnapshot().current?.step.index).toBe(1)
  })

  it('plants nothing new when the reader closes a step read again', async () => {
    await loadOnce(RUN_ON.replace('stop: no\n', ''))
    await pass(0x8000)
    next() // Continue: step 2 goes in, and the guest runs towards it
    await settle()
    revisit(0)
    next() // closes the step read again
    await settle()
    expect(planted()).toEqual([1])
    expect([...breakpoints]).toEqual([0x9000])
    expect(resumed).toHaveLength(1) // the guest was running already
  })

  it('keeps a repeating step planted, and plants nothing past the next when it comes round', async () => {
    await loadOnce(RUN_ON.replace('stop: no\n', 'repeat: yes\n'))
    await pass(0x8000)
    next()
    await settle()
    // It keeps its breakpoint beside step 2's, and comes round again first.
    expect(planted()).toEqual([0, 1])
    await pass(0x8000)
    expect(getSnapshot().current?.step.index).toBe(0)
    next()
    await settle()
    expect(planted()).toEqual([0, 1])
    await pass(0xa000)
    expect(getSnapshot().current).toBeNull()
    await pass(0x9000)
    expect(getSnapshot().current?.step.index).toBe(1)
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
    // Step 1 repeats on the line step 2 stops at, so when step 2 fires, the
    // breakpoint stays in for step 1.
    await loadOnce(RUN_ON.replace('stop: no\n', 'repeat: yes\n').replace('0x9000', '0x8000'))
    await pass(0x8000)
    next()
    await settle()
    await pass(0x8000)
    expect(getSnapshot().current?.step.index).toBe(1)
    expect(planted()).toEqual([0])
    expect(breakpoints.has(0x8000)).toBe(true)
  })

  it('reads nothing at the stop for a step without state predicates', async () => {
    // Hit conditions cost what they always did: the registers, and no memory.
    await stopAt(0x8000)
    expect(getSnapshot().current?.step.index).toBe(0)
    expect(filterReads).toEqual([])
  })

  it('slips past hits no step asked for, without ever pausing', async () => {
    await stopAt(0x8000)
    next() // step 1 fires and is done
    await settle()
    await stopAt(0x8000) // step 2's first hit, and it wants every fourth
    expect(getSnapshot().current).toBeNull()
    // The rejected hit never reached the expensive path: no pause published,
    // no thread walk, and the store did not have to resume anything.
    expect(swallowed).toEqual(['00008000'])
    expect(resumed).toHaveLength(1) // just the `next()` above
    expect(paused).toBe(false)
  })

  it('does not spend a step\'s hits while another card is up', async () => {
    await stopAt(0x8000) // step 1
    next()
    await settle()
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000) // step 2, on its fourth hit
    // Its card is up (`stop: no`), and the guest runs on towards step 3.
    expect(getSnapshot().current?.step.index).toBe(1)
    swallowed.length = 0
    await stopAt(0x9000)
    expect(swallowed).toEqual(['00009000'])
    expect(getSteps()[2]!.hits).toBe(0) // still to come, not used up
  })

  it('fires the repeating step on its hit and runs on when `stop: no`', async () => {
    await stopAt(0x8000)
    next()
    await settle()
    // Step 2 counts from here, once it is planted, not from step 1's stop.
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000) // hit 4
    expect(swallowed).toHaveLength(3) // hits 1 to 3 cost nothing
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
    await stopAt(0x8000)
    await stopAt(0x8000) // step 2 (repeat, stop: no) keeps its BP planted
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
    // A repeating step keeps its breakpoint while its card is up.
    await loadOnce(RUN_ON.replace('stop: no\n', 'repeat: yes\n'))
    await pass(0x8000)
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

/*
 * A dot in the outline opens a step already shown. The card it covers is where
 * the reader really is, and closing the step read again has to take them back
 * there, with the guest exactly as it was.
 */
describe('reading a step again', () => {
  /** RUN_ON with every step stopping, so the guest is paused under each card. */
  const STOPS = RUN_ON.replace('stop: no\n', '')

  it('puts the paused card back, still paused, and its Continue resumes as usual', async () => {
    await loadOnce(STOPS)
    await pass(0x8000)
    next()
    await settle()
    await pass(0x9000)
    const live = getSnapshot().current
    expect(live?.paused).toBe(true)

    revisit(0)
    expect(getSnapshot().current).toMatchObject({ step: { index: 0 }, paused: false })
    next() // Back
    await settle()
    // The same card, the guest still stopped under it, and the tour no further
    // on: step 3 goes in when the reader continues, not when they look back.
    expect(getSnapshot().current).toBe(live)
    expect(paused).toBe(true)
    expect(resumed).toHaveLength(1)
    expect(planted()).toEqual([])
    expect(breakpoints.size).toBe(0)

    next() // Continue
    await settle()
    expect(planted()).toEqual([2])
    expect(resumed).toHaveLength(2)
    expect(paused).toBe(false)
  })

  it('never finishes the tour from a step read again', async () => {
    await loadLifecycle()
    await stopAt(0x8000)
    next()
    await settle()
    await stopAt(0x9000) // the last step
    const last = getSnapshot().current
    revisit(0)
    next() // Back
    await settle()
    expect(getSnapshot().current).toBe(last)
    expect(getSnapshot()).toMatchObject({ finished: false, completed: false })
    expect(paused).toBe(true)

    next() // Continue
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: true })
    expect(paused).toBe(false)
  })

  it('puts back a card the guest runs on under, and plants nothing', async () => {
    // TOUR's second step is a note: its card stays up while the guest runs on
    // towards the third.
    await stopAt(0x8000)
    next()
    await settle()
    for (let i = 0; i < 4; i++) await stopAt(0x8000)
    const note = getSnapshot().current
    expect(note).toMatchObject({ step: { index: 1 }, paused: false })
    const before = { planted: planted(), resumed: resumed.length }

    revisit(0)
    next()
    await settle()
    expect(getSnapshot().current).toBe(note)
    expect(planted()).toEqual(before.planted)
    expect(resumed).toHaveLength(before.resumed)
  })

  it('returns to the your-turn card, and plants, resumes and reopens nothing', async () => {
    await loadLifecycle()
    await stopAt(0x8000)
    next()
    await settle()
    const waiting = getSnapshot().waiting
    expect(waiting?.index).toBe(1)

    revisit(0)
    next() // Back
    await settle()
    expect(getSnapshot().current).toBeNull()
    expect(getSnapshot().waiting).toEqual(waiting)
    expect([...breakpoints]).toEqual([0x9000])
    expect(resumed).toHaveLength(1)
    // The step's panel opened when its your-turn card first went up, and does
    // not blink open again.
    expect(revealed).toEqual(['keys'])
  })

  it('closes, and leaves the tour alone, when no card was up', async () => {
    await loadOnce(RUN_ON)
    await pass(0x8000) // the note
    next() // Got it: the guest runs on towards step 2, with nothing on screen
    await settle()
    expect(getSnapshot()).toMatchObject({ current: null, waiting: null })

    revisit(0)
    next()
    await settle()
    expect(getSnapshot()).toMatchObject({ current: null, waiting: null, finished: false })
    expect(planted()).toEqual([1])
    expect(resumed).toHaveLength(1)
  })

  it('keeps the way back however many steps are read on the way', async () => {
    await loadOnce(STOPS)
    for (const addr of [0x8000, 0x9000]) {
      await pass(addr)
      next()
      await settle()
    }
    await pass(0xa000)
    const live = getSnapshot().current
    revisit(0)
    revisit(1) // from the step read again
    expect(getSnapshot().current?.step.index).toBe(1)
    next()
    expect(getSnapshot().current).toBe(live)
  })

  it('goes straight back when the reader picks the step the tour is on', async () => {
    await loadOnce(STOPS)
    await pass(0x8000)
    next()
    await settle()
    await pass(0x9000)
    const live = getSnapshot().current
    revisit(1) // its own dot: there is nothing to read again
    expect(getSnapshot().current).toBe(live)
    revisit(0)
    revisit(1)
    expect(getSnapshot().current).toBe(live)
  })

  it('keeps a step that fires as the reader looks back, behind the step read again', async () => {
    await loadLifecycle()
    await stopAt(0x8000)
    next()
    await settle()
    // The filter keeps the hit, and the reader picks a dot on the your-turn card
    // before the stop is published.
    const stop = stopAt(0x9000)
    revisit(0)
    await stop
    expect(getSnapshot().current?.step.index).toBe(0)
    expect(getSnapshot().waiting).toBeNull()

    next() // Back
    expect(getSnapshot().current).toMatchObject({ step: { index: 1 }, paused: true })
    expect(paused).toBe(true)
  })

  it('still lets the guest go when the reader leaves from a step read again', async () => {
    await loadOnce(STOPS)
    await pass(0x8000)
    next()
    await settle()
    await pass(0x9000)
    revisit(0)
    skip()
    await settle()
    expect(getSnapshot()).toMatchObject({ current: null, finished: true, completed: false })
    expect(breakpoints.size).toBe(0)
    expect(paused).toBe(false)
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

/** The same finale, after a note the guest runs on under. */
const NOTED = CHECKED.replace(
  '## The alarm goes in',
  `## A note first

\`\`\`tour
at: 0x7000
stop: no
\`\`\`

Prose.

## The alarm goes in`,
)

describe('checks', () => {
  /** `alarms_lost`, as the guest has it at the next stop. */
  function lost(count: number) {
    ;[count, 0, 0, 0].forEach((byte, i) => memory.set(0x3000 + i, byte))
  }

  beforeEach(() => loadOnce(CHECKED))

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
    await loadOnce(CHECKED.replace('at: 0x8000\n', 'at: 0x8000\nwhen: first\n'))
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
    await loadOnce(CHECKED.replace(/## Afterwards[\s\S]*?Prose\.\n\n/, ''))
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
    await loadOnce(CHECKED.replace('retry: yes\n', ''))
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
    await loadOnce(CHECKED.replace('alarms_lost as u32 == 0', 'nope as u32 == 0'))
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

  it('holds the line from a `stop: no` note before it until it passes', async () => {
    await loadOnce(NOTED)
    await pass(0x7000) // the note: the retry step goes in, and the guest runs on
    next() // Got it
    await settle()
    lost(1)
    await pass(0x8000) // a try that fails
    next() // Try again
    await settle()
    // Nothing after the retry step is in, so the guest goes by that line freely.
    expect([...breakpoints]).toEqual([0x8000])
    await pass(0x9000)
    expect(swallowed).toEqual([])
    lost(0)
    await pass(0x8000)
    expect(getSnapshot().current?.check?.outcome).toBe('passed')
    next()
    await settle()
    await pass(0x9000)
    expect(getSnapshot().current?.step.title).toBe('Afterwards')
  })

  it('leaves a step with no checks without a verdict', async () => {
    await loadOnce(LIFECYCLE)
    await stopAt(0x8000)
    expect(getSnapshot().current?.check).toBeNull()
  })
})

describe('member views', () => {
  afterEach(() => {
    kernelElf = null
  })

  it('reads a struct member at the offset the build’s DWARF gives, walking it once per image', async () => {
    kernelElf = new Uint8Array(1)
    reset()
    tourText.body = `---
tour: Members
sample: samples/kernel/msg_queue
---

## The queue

\`\`\`tour
at: 0x8000
watch:
  - used = k_msgq(readings).used_msgs as u32
  - again = k_msgq(readings).used_msgs as u32
  - nope = k_msgq(readings).nope as u32
\`\`\`

Prose.
`
    await loadFor(`tour-${url++}`)
    await arm()
    ;[7, 0, 0, 0].forEach((byte, i) => memory.set(0x4420 + i, byte))
    await stopAt(0x8000)
    expect(getSnapshot().current?.values.map((v) => v.text)).toEqual([
      '7',
      '7',
      'no member `nope` in `struct k_msgq`',
    ])
    expect(dwarf.walks).toBe(1)
  })
})

/**
 * A step on a hot address, picked out by what the target looks like: Part B's
 * priority step, where any producer in the system can call the same put.
 */
const CONDITIONAL = `---
tour: Conditional
sample: samples/kernel/msg_queue
---

## The third put to readings

\`\`\`tour
at: 0x8000
when:
  - $arg0 == readings
  - hits == 3
watch:
  - used = counter as u32
\`\`\`

Prose.

## Somewhere else

\`\`\`tour
at: 0x9000
\`\`\`

Prose.
`

/** The stop's registers with x0, which is `$arg0` on AArch64, set to `value`. */
const withArg0 = (value: number) => `PC=00008000\nX00=${value.toString(16).padStart(16, '0')}`

async function loadConditional(body = CONDITIONAL) {
  reset()
  tourText.body = body
  await loadFor(`tour-${url++}`)
  await arm()
}

describe('state predicates in `when:`', () => {
  beforeEach(() => loadConditional())

  afterEach(() => {
    kernelElf = null
  })

  it('does not count a hit where a predicate is false, and never pauses for it', async () => {
    await stopAt(0x8000, withArg0(0x4800)) // a put to some other queue
    expect(getSteps()[0]!.hits).toBe(0)
    await stopAt(0x8000, withArg0(0x4400)) // the first put to readings
    await stopAt(0x8000, withArg0(0x4800))
    await stopAt(0x8000, withArg0(0x4400)) // the second
    expect(getSteps()[0]!.hits).toBe(2)
    expect(swallowed).toHaveLength(4)
    expect(getSnapshot().current).toBeNull()
    expect(paused).toBe(false)
    expect(resumed).toHaveLength(0)

    await stopAt(0x8000, withArg0(0x4400)) // the third: this one
    const card = getSnapshot().current
    expect(card?.step.title).toBe('The third put to readings')
    expect(card?.hits).toBe(3)
    expect(paused).toBe(true)
  })

  it('reads target memory through the stop, before anything is published', async () => {
    await loadConditional(
      CONDITIONAL.replace('$arg0 == readings', 'counter as u32 == 5').replace('hits == 3', 'first'),
    )
    stopMemory.set(0x4500, new Uint8Array([4, 0, 0, 0]))
    await stopAt(0x8000)
    expect(filterReads).toEqual([0x4500])
    expect(getSnapshot().current).toBeNull()

    stopMemory.set(0x4500, new Uint8Array([5, 0, 0, 0]))
    await stopAt(0x8000)
    expect(getSnapshot().current?.hits).toBe(1)
  })

  it('skips a step whose predicate names what the build does not have', async () => {
    await loadConditional(CONDITIONAL.replace('$arg0 == readings', '$arg0 == writings'))
    expect(getSteps()[0]!.unresolved).toBe(true)
    expect(getSnapshot().problems).toEqual([
      'step 1: `when:` names `writings`, which this build does not have',
    ])
    // The tour goes on without it, rather than waiting for a hit that can
    // never count.
    expect(getSteps().map((s) => s.planted)).toEqual([false, true])
  })

  it('reads a member view through the build’s DWARF, looked up once', async () => {
    kernelElf = new Uint8Array(1)
    await loadConditional(
      CONDITIONAL.replace('$arg0 == readings', 'k_msgq(readings).used_msgs as u32 == 7').replace(
        'hits == 3',
        'first',
      ),
    )
    // Looked up at arm, while the guest is frozen anyway, not on the first hit.
    expect(dwarf.walks).toBe(1)
    stopMemory.set(0x4420, new Uint8Array([6, 0, 0, 0]))
    await stopAt(0x8000)
    stopMemory.set(0x4420, new Uint8Array([7, 0, 0, 0]))
    await stopAt(0x8000)
    expect(getSnapshot().current?.step.index).toBe(0)
    expect(filterReads).toEqual([0x4420, 0x4420])
    expect(dwarf.walks).toBe(1)
  })

  it('skips a step whose member view the build does not describe', async () => {
    kernelElf = new Uint8Array(1)
    await loadConditional(CONDITIONAL.replace('$arg0 == readings', 'k_msgq(readings).used as u32 == 7'))
    expect(getSteps()[0]!.unresolved).toBe(true)
    expect(getSnapshot().problems[0]).toContain('`k_msgq(…).used`')
  })

  it('lets a hit go when the reader leaves while its predicates are being read', async () => {
    await loadConditional(
      CONDITIONAL.replace('$arg0 == readings', 'counter as u32 == 5').replace('hits == 3', 'first'),
    )
    stopMemory.set(0x4500, new Uint8Array([5, 0, 0, 0]))
    let answer!: () => void
    readGate = new Promise((resolve) => {
      answer = resolve
    })
    const stop = stopAt(0x8000)
    await settle()
    skip()
    answer()
    await stop
    // The predicate held, but nobody is waiting for the step any more.
    expect(swallowed).toEqual(['00008000'])
    expect(getSteps()[0]!.hits).toBe(0)
    expect(getSnapshot().current).toBeNull()
  })

  it('lets a hit go when a new guest starts while its predicates are being read', async () => {
    let answer!: () => void
    readGate = new Promise((resolve) => {
      answer = resolve
    })
    await loadConditional(
      CONDITIONAL.replace('$arg0 == readings', 'counter as u32 == 5').replace('hits == 3', 'first'),
    )
    stopMemory.set(0x4500, new Uint8Array([5, 0, 0, 0]))
    const stop = stopAt(0x8000) // hostGdb asked before the reset unhooked the filter
    await settle()
    reset()
    answer()
    await stop
    expect(swallowed).toEqual(['00008000'])
    expect(getSnapshot().current).toBeNull()
  })
})

/** Three stops in a row; this build has nothing called `no_such_function`. */
const LINEAR = `---
tour: Linear
sample: samples/basic/blinky
---

## One

\`\`\`tour
at: no_such_function
\`\`\`

Prose.

## Two

\`\`\`tour
at: 0x9000
\`\`\`

Prose.

## Three

\`\`\`tour
at: 0xa000
\`\`\`

Prose.
`

describe('starting part-way, from a `?step=` link', () => {
  async function loadAt(startIndex: number) {
    reset()
    breakpoints.clear()
    tourText.body = LINEAR
    const id = `tour-${url++}`
    // The fake session is already up, so loading arms the tour by itself:
    // arming it again here would plant one step ahead.
    await loadFor(id, undefined, { startIndex })
    await settle()
    return id
  }

  it('plants the step the link starts at first, and skips the ones before', async () => {
    const id = await loadAt(1)
    expect([...breakpoints]).toEqual([0x9000])
    expect(getSteps().map((s) => s.skipped)).toEqual([true, false, false])
    // Skipped is not unresolved: nobody asked this build about step 1's anchor.
    expect(getSteps()[0]!.unresolved).toBe(false)
    expect(getSnapshot()).toMatchObject({ tourId: id, startIndex: 1, armed: true, problems: [] })
  })

  it('finishes once every step from there on has had its turn', async () => {
    await loadAt(1)
    await stopAt(0x9000)
    expect(getSnapshot().current?.step.title).toBe('Two')
    next()
    await settle()
    expect([...breakpoints]).toEqual([0xa000])
    await stopAt(0xa000)
    next()
    await settle()
    expect(getSnapshot()).toMatchObject({ finished: true, completed: true })
    expect([...getSnapshot().seen]).toEqual([1, 2])
  })

  it('still reports what it cannot resolve when the tour starts at the top', async () => {
    await loadAt(0)
    expect(getSnapshot().startIndex).toBe(0)
    expect(getSnapshot().problems).toEqual([expect.stringContaining('step 1')])
    expect([...breakpoints]).toEqual([0x9000])
  })

  it('takes the tour from the top when the link names a step past the end', async () => {
    await loadAt(7)
    expect(getSnapshot().startIndex).toBe(0)
    expect(getSteps().some((s) => s.skipped)).toBe(false)
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

  async function replay(body: string, opts?: { startIndex?: number }) {
    reset()
    tourText.body = body
    vi.useFakeTimers()
    const ac = new AbortController()
    startDemo(`tour-${url++}`, ac.signal, opts)
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

  it('starts where a `?step=` link starts the real tour', async () => {
    const ac = await replay(LIFECYCLE, { startIndex: 1 })
    expect(getSnapshot().startIndex).toBe(1)
    expect(await beats(3)).toEqual(['your turn: 2', 'A press arrives', 'complete'])
    expect([...getSnapshot().seen]).toEqual([1])
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
