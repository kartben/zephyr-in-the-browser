import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hostGdb from '@/hostGdb'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'

/*
 * The tour engine over the real debugger, against a stub that re-traps a
 * continue from a breakpoint the way QEMU's does. store.test.ts fakes the
 * debugger and so cannot see this: every hit it delivers is a real pass.
 */

const tourText = vi.hoisted(() => ({ body: '' }))

vi.mock('@/tours/catalog', () => ({
  loadTourSource: async () => tourText.body,
  hasTour: () => true,
  tourIds: () => ['tour'],
  baseSampleId: (id: string) => id,
}))

vi.mock('@/lib/dockReveal', () => ({
  revealPanelKind: () => {},
}))

const { getSnapshot, getSteps, loadFor, next, reset } = await import('@/tours/store')

const LOCK = 0x2000

function tour(...steps: string[]): string {
  return `---
tour: Retrap
sample: samples/philosophers
---
${steps.map((body, i) => `\n## Step ${i + 1}\n\n\`\`\`tour\n${body}\n\`\`\`\n\nProse.\n`).join('')}`
}

let server: FakeRspServer
let id = 0

async function start(body: string) {
  tourText.body = body
  hostGdb.bindLive('arm')
  server = new FakeRspServer({ pc: 0x1000 })
  expect(await hostGdb.attachLiveSession(server.transport())).toBe(true)
  // A fresh id each time: the tour cache is keyed by it.
  await loadFor(`retrap-${id++}`)
  await vi.waitFor(() => expect(getSnapshot().armed).toBe(true))
}

/** The guest reaches `addr` once, for real. */
async function pass(addr: number) {
  server.hitBreakpoint(addr)
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  reset()
})

afterEach(() => {
  reset()
  hostGdb.detach()
})

describe('tours over a stub that re-traps on continue', () => {
  it('`when: hits == 2` fires on the second real pass, not a re-trap of the first', async () => {
    await start(tour(`at: 0x${LOCK.toString(16)}\nwhen: hits == 2`))
    await pass(LOCK)
    expect(getSnapshot().current).toBeNull()
    expect(getSteps()[0]!.hits).toBe(1)
    expect(server.running).toBe(true)

    await pass(LOCK)
    await vi.waitFor(() => expect(getSnapshot().current?.hits).toBe(2))
  })

  it('two consecutive steps on one address fire on two passes', async () => {
    const at = `at: 0x${LOCK.toString(16)}\nwhen: first`
    await start(tour(at, at))
    await pass(LOCK)
    await vi.waitFor(() => expect(getSnapshot().current?.step.index).toBe(0))

    next()
    await vi.waitFor(() => expect(server.running).toBe(true))
    // Let go from the address step 2 was just planted on, without firing it.
    expect(server.pc).toBe(LOCK + 2)
    expect(getSnapshot().current).toBeNull()
    expect(getSteps()[1]!.hits).toBe(0)

    // Only the next real arrival is step 2's.
    server.hitBreakpoint(LOCK)
    await vi.waitFor(() => expect(getSnapshot().current?.step.index).toBe(1))
    expect(getSteps()[1]!.hits).toBe(1)
  })
})
