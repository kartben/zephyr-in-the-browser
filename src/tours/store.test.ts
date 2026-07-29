import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  getKernelElf: () => null,
  getSymbolIndex: () => ({
    byAddr: [{ name: 'main', addr: 0x8000, size: 0x40 }],
    byName: [{ name: 'main', addr: 0x8000, size: 0x40 }],
    objects: new Map([['led', { name: 'led', addr: 0x2000, size: 8 }]]),
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
    new Uint8Array(length).fill(addr & 0xff),
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
vi.mock('@/tours/catalog', () => ({
  loadTourSource: async (id: string) => (id.startsWith('tour-') ? TOUR : null),
  hasTour: () => true,
  tourIds: () => ['tour'],
  baseSampleId: (id: string) => id.replace(/_trace$/, ''),
}))

const revealed: string[] = []
vi.mock('@/lib/dockReveal', () => ({
  revealPanelKind: (kind: string) => revealed.push(kind),
  revealTrace: (tab: string) => revealed.push(`trace:${tab}`),
}))

const { arm, getSnapshot, getSteps, loadFor, next, reset, skip } = await import('@/tours/store')

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
  stopFilter = null
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
})
