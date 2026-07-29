import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The stop → card seam, end to end through the *real* hostGdb.
 *
 * Everything either side of this seam had tests and it still shipped broken
 * twice, because both sides were mocked: the store's tests faked hostGdb, and
 * hostGdb had no test that ran a tour through it. What was never exercised is
 * the ordering between them — when the filter is asked, when `paused` is
 * published, when the PC lands, and whether `showPending()` is still holding a
 * verdict by the time it is called.
 *
 * So only the wire is faked here. `RspClient` is replaced by a stub that
 * records packets and lets a test deliver a stop; `hostGdb.attachSession()`,
 * its stop handler, `refreshRegs()` and the whole of `src/tours/store.ts` are
 * the real thing.
 */

/** AArch64 `g` reply: x0..x30, sp, pc, pstate — pc is what the tour reads. */
function gPacket(pc: number): string {
  const words: string[] = []
  for (let i = 0; i < 31; i++) words.push('00'.repeat(8)) // x0..x30
  words.push('00'.repeat(8)) // sp
  const le = new Uint8Array(8)
  new DataView(le.buffer).setBigUint64(0, BigInt(pc), true)
  words.push([...le].map((b) => b.toString(16).padStart(2, '0')).join(''))
  words.push('00000000') // pstate
  return words.join('')
}

let stopHandler: ((info: { kind: string }) => void) | null = null
const inserted = new Set<number>()
const removed: number[] = []
let continues = 0
let currentPc = 0

class FakeRspClient {
  setStopHandler(fn: ((info: { kind: string }) => void) | null) {
    stopHandler = fn
  }
  poll() {}
  async start() {
    return null // attached, machine already running
  }
  async continue() {
    continues++
  }
  async interrupt() {
    return { kind: 'signal' }
  }
  async step() {
    return { kind: 'signal' }
  }
  async readRegisters() {
    return gPacket(currentPc)
  }
  async readMemory(_addr: number, length: number) {
    return new Uint8Array(length)
  }
  async writeMemory() {}
  async insertSwBreakpoint(addr: number) {
    inserted.add(addr)
    return true
  }
  async removeSwBreakpoint(addr: number) {
    inserted.delete(addr)
    removed.push(addr)
    return true
  }
}

vi.mock('@/debug/gdb/rspClient', () => ({ RspClient: FakeRspClient }))
vi.mock('@/debug/browserChardev', () => ({
  bindChardev: () => ({ feed: () => 0, ring: () => 0 }),
  chardevAvailable: () => true,
}))
vi.mock('@/lib/dockReveal', () => ({ revealPanelKind: () => {} }))

const TOUR = `---
tour: Live test
sample: samples/basic/blinky
---

## The first statement of main

\`\`\`tour
at: main
when: first
panel: gpio
watch:
  - pin = led as u8
\`\`\`

Prose the reader is supposed to see.
`

vi.mock('@/tours/catalog', () => ({
  loadTourSource: async () => TOUR,
  hasTour: () => true,
  tourIds: () => ['blinky'],
  baseSampleId: (id: string) => id,
}))

const MAIN = 0x40001000

vi.mock('@/debug/elfSymbols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/debug/elfSymbols')>()
  return {
    ...actual,
    buildSymbolIndex: () => ({
      byAddr: [{ name: 'main', addr: MAIN, size: 0x40 }],
      byName: [{ name: 'main', addr: MAIN, size: 0x40 }],
      objects: new Map([['led', { name: 'led', addr: 0x40002000, size: 8 }]]),
    }),
  }
})

const gdb = await import('@/hostGdb')
const tours = await import('@/tours/store')

/** Enough of an Emscripten module for bind() to accept it. */
const MODULE = {
  _qemu_browser_gdb_attach: () => 0,
  _qemu_browser_gdb_detach: () => {},
  HEAPU8: new Uint8Array(16),
}

/** Deliver a breakpoint trap at `pc`, the way QEMU's stub would. */
async function trapAt(pc: number) {
  currentPc = pc
  stopHandler?.({ kind: 'signal' })
  // The handler reads registers, publishes, and refreshes — all async.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Bring up a session.
 *
 * `order` is the thing under test as much as anything else. In production
 * App.tsx loads the tour as the terminal session starts and the backend binds
 * gdb later, once the emulator module exists — but a tour loaded after boot
 * (or a reload that races) takes the other order, and both have to work.
 */
async function boot(order: 'tour-first' | 'gdb-first') {
  tours.reset()
  gdb.resetForTests()
  stopHandler = null
  inserted.clear()
  removed.length = 0
  continues = 0
  currentPc = 0
  // A one-byte ELF stands in for the image: buildSymbolIndex is mocked, and
  // there is no line table, so `at: main` resolves through symbols alone.
  gdb.setKernelImage(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))
  if (order === 'tour-first') {
    await tours.loadFor('blinky')
    gdb.bind(MODULE, 'aarch64')
  } else {
    gdb.bind(MODULE, 'aarch64')
    await tours.loadFor('blinky')
  }
  await gdb.attachSession()
}

beforeEach(async () => {
  await boot('tour-first')
})

describe('a tour on a live session', () => {
  it('plants its breakpoints at the attach stop', () => {
    expect([...inserted]).toEqual([MAIN])
    expect(tours.getSnapshot().armed).toBe(true)
    expect(tours.getSnapshot().problems).toEqual([])
  })

  it('shows the card when the guest reaches the step', async () => {
    await trapAt(MAIN)
    const card = tours.getSnapshot().current
    expect(card, 'the machine stopped but no card was published').not.toBeNull()
    expect(card!.step.title).toBe('The first statement of main')
    expect(card!.paused).toBe(true)
    // And the machine is genuinely stopped underneath it.
    expect(gdb.getSnapshot().paused).toBe(true)
  })

  it('leaves a stop that is not the tour’s alone', async () => {
    await trapAt(0x40009999)
    expect(tours.getSnapshot().current).toBeNull()
    // Not swallowed: a user breakpoint or Pause must still stop the machine.
    expect(gdb.getSnapshot().paused).toBe(true)
    expect(continues).toBe(0)
  })

  it('continues past a hit no step wants, without pausing', async () => {
    await trapAt(MAIN) // step fires
    tours.next() // reader continues; `when: first` is spent, breakpoint lifted
    expect(removed).toContain(MAIN)
  })
})

describe('whichever order the tour and the session arrive in', () => {
  /*
   * The deployed bug: bind() detaches first, and detach() was clearing the stop
   * filter the tour had already registered — while leaving the attach hook, so
   * breakpoints still went in. Breakpoints in the panel, no card, and nothing
   * on screen to say why. Both orders now, so it cannot come back from either
   * side.
   */
  it.each(['tour-first', 'gdb-first'] as const)('arms and shows the card (%s)', async (order) => {
    await boot(order)
    expect([...inserted], 'breakpoint was not planted').toEqual([MAIN])
    await trapAt(MAIN)
    expect(tours.getSnapshot().current, 'stopped, but no card').not.toBeNull()
  })
})
