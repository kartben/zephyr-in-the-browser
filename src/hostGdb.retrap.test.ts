/**
 * Continuing from a breakpoint. The fake server re-traps a continue that
 * starts on an inserted breakpoint, like QEMU and OpenOCD both do, so a
 * client that just sends `vCont;c` sees the same hit again straight away.
 * hostGdb has to step off it first, on the filter's continue and on Resume.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as hostGdb from '@/hostGdb'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'

const BP = 0x2000

afterEach(() => {
  hostGdb.setStopFilter(null)
  hostGdb.detach()
})

async function attached(): Promise<FakeRspServer> {
  hostGdb.bindLive('arm')
  const server = new FakeRspServer({ pc: 0x1000 })
  expect(await hostGdb.attachLiveSession(server.transport())).toBe(true)
  return server
}

/** Let the async stop handler run to completion. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * A filter that rejects every hit. It gives up after a few, so a regression
 * (re-trapping on the same breakpoint forever) fails the test instead of
 * hanging it.
 */
function rejectAll(seen: string[]): (pc: string) => boolean {
  return (pc) => {
    seen.push(pc)
    return seen.length < 5
  }
}

/** Wait for a kept stop to be published and its registers read. */
async function stoppedAndRead() {
  await vi.waitFor(() => {
    const snap = hostGdb.getSnapshot()
    expect(snap.paused && !snap.registersLoading && snap.pc !== null).toBe(true)
  })
}

/** Packets after `from`, run control only. */
function runControl(server: FakeRspServer, from: number): string[] {
  return server.packets.slice(from).filter((p) => p.startsWith('vCont;'))
}

describe('continuing from a breakpoint', () => {
  it('a hit the filter rejects is counted once, and the guest runs on', async () => {
    const server = await attached()
    await hostGdb.addBreakpoint(BP)
    const seen: string[] = []
    hostGdb.setStopFilter(rejectAll(seen))
    const mark = server.packets.length
    server.hitBreakpoint(BP)
    await settle()
    expect(seen).toEqual(['00002000'])
    expect(runControl(server, mark)).toEqual(['vCont;s', 'vCont;c'])
    expect(server.running).toBe(true)
    expect(server.pc).toBe(BP + 2)
    expect(hostGdb.getSnapshot().paused).toBe(false)
  })

  it('Resume from a kept stop steps off the breakpoint first', async () => {
    const server = await attached()
    await hostGdb.addBreakpoint(BP)
    const seen: string[] = []
    hostGdb.setStopFilter((pc) => {
      seen.push(pc)
      return false
    })
    server.hitBreakpoint(BP)
    await stoppedAndRead()

    const mark = server.packets.length
    await hostGdb.resume()
    await settle()
    expect(runControl(server, mark)).toEqual(['vCont;s', 'vCont;c'])
    expect(server.running).toBe(true)
    expect(seen).toEqual(['00002000']) // the step's stop was never offered
    expect(hostGdb.getSnapshot().paused).toBe(false)
  })

  it('a breakpoint lifted and re-planted on the stop PC waits for the next pass', async () => {
    // What a tour does for two consecutive steps on one address.
    const server = await attached()
    await hostGdb.addBreakpoint(BP)
    const seen: string[] = []
    hostGdb.setStopFilter((pc) => {
      seen.push(pc)
      return false
    })
    server.hitBreakpoint(BP)
    await stoppedAndRead()
    await hostGdb.removeBreakpoint(BP)
    await hostGdb.addBreakpoint(BP)
    await hostGdb.resume()
    await settle()
    expect(seen).toHaveLength(1)
    expect(server.running).toBe(true)
    server.hitBreakpoint(BP)
    await settle()
    expect(seen).toHaveLength(2)
  })

  it('Resume with no breakpoint at the PC does not step', async () => {
    const server = await attached()
    await hostGdb.addBreakpoint(BP)
    await hostGdb.pause() // parked at 0x1000
    const mark = server.packets.length
    await hostGdb.resume()
    expect(runControl(server, mark)).toEqual(['vCont;c'])
    expect(server.running).toBe(true)
  })

  it('a step that lands on another breakpoint reports that one as a hit', async () => {
    const server = await attached()
    await hostGdb.addBreakpoint(BP)
    await hostGdb.addBreakpoint(BP + 2)
    const seen: string[] = []
    hostGdb.setStopFilter(rejectAll(seen))
    server.hitBreakpoint(BP)
    await settle()
    // Stepped off 0x2000 onto 0x2002, whose continue trapped at once: a real
    // arrival, offered to the filter like any other, then stepped off in turn.
    expect(seen).toEqual(['00002000', '00002002'])
    expect(server.running).toBe(true)
    expect(server.pc).toBe(BP + 4)
  })
})
