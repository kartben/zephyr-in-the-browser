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

const revealed: string[] = []
vi.mock('@/lib/dockReveal', () => ({
  revealPanelKind: (kind: string) => revealed.push(kind),
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

/** Deliver a stop at `addr`, the way the gdb poll loop would. */
async function stopAt(addr: number) {
  paused = true
  pc = addr.toString(16).padStart(8, '0')
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(TOUR, { headers: { 'content-type': 'text/markdown' } })),
  )
  // A fresh URL each time: the tour cache is keyed by it, deliberately.
  await loadFor(`/tour-${url++}.tour.md`)
  await arm()
})

describe('arming', () => {
  it('plants a breakpoint per resolvable step and reports the rest', () => {
    // `main` resolves through symbols; 0x9000 is a raw address; both plant.
    expect([...breakpoints].sort()).toEqual([0x8000, 0x9000])
    expect(getSnapshot().armed).toBe(true)
    expect(getSnapshot().problems).toEqual([])
  })
})

describe('stops', () => {
  it('ignores a stop that belongs to nobody', async () => {
    await stopAt(0x1234)
    expect(getSnapshot().current).toBeNull()
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
    // Step 2 shares the address and repeats, so the breakpoint stays.
    expect(breakpoints.has(0x8000)).toBe(true)
    expect(getSteps()[0]!.planted).toBe(false)
    expect(getSteps()[1]!.planted).toBe(true)
  })

  it('slips past hits no step asked for', async () => {
    await stopAt(0x8000)
    next() // step 1 fires and is done
    await stopAt(0x8000) // hit 2 — step 2 wants every fourth
    expect(getSnapshot().current).toBeNull()
    expect(resumed).toHaveLength(2) // the `next()` above, then this stop
    expect(paused).toBe(false)
  })

  it('fires the repeating step on its hit and runs on when `stop: no`', async () => {
    await stopAt(0x8000)
    next()
    await stopAt(0x8000)
    await stopAt(0x8000)
    await stopAt(0x8000) // hit 4
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
    await new Promise((r) => setTimeout(r, 0))
    expect(breakpoints.size).toBe(0)
    expect(getSnapshot().finished).toBe(true)
    expect(getSnapshot().current).toBeNull()
  })
})
