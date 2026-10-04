/**
 * The stop filter, over the real client and a scripted stub.
 *
 * A filter can read target state before it decides, so it is async, and the
 * guest sits frozen at an unpublished stop for as long as it takes. Nothing
 * may publish a pause in that window unless the stop is kept, and nothing may
 * be sent to the stub once the stop has been let go.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as hostGdb from '@/hostGdb'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'

const BP = 0x2000

afterEach(() => {
  hostGdb.setStopFilter(null)
  hostGdb.detach()
  vi.restoreAllMocks()
})

async function attached(): Promise<FakeRspServer> {
  hostGdb.bindLive('arm')
  const server = new FakeRspServer({ pc: 0x1000 })
  expect(await hostGdb.attachLiveSession(server.transport())).toBe(true)
  await hostGdb.addBreakpoint(BP)
  return server
}

/** Let the async stop handler run to completion. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Every `paused` the debugger publishes from now on. */
function watchPaused(): boolean[] {
  const seen: boolean[] = []
  hostGdb.subscribe(() => seen.push(hostGdb.getSnapshot().paused))
  return seen
}

describe('the stop filter', () => {
  it('is shown the registers, and reads memory from the stub before anything is published', async () => {
    const server = await attached()
    server.registers.set(0, 0x3000) // r0, which is $arg0 on Cortex-M
    server.load(0x3000, [5, 0, 0, 0])
    let shown: hostGdb.StopContext | null = null
    let bytes: Uint8Array | null = null
    hostGdb.setStopFilter(async (stop) => {
      shown = stop
      bytes = await stop.read(0x3000, 4)
      return true
    })
    const mark = server.packets.length
    server.hitBreakpoint(BP)
    await settle()

    expect(shown!.pc).toBe('00002000')
    expect(shown!.registers).toContain('R00=00003000')
    expect([...bytes!]).toEqual([5, 0, 0, 0])
    // One register read, the filter's own memory read, then off the breakpoint.
    expect(server.packets.slice(mark)).toEqual(['g', 'm3000,4', 'vCont;s', 'vCont;c'])
    expect(server.running).toBe(true)
  })

  it('never publishes a pause for a stop it rejects, however much it reads', async () => {
    const server = await attached()
    const paused = watchPaused()
    let reads = 0
    hostGdb.setStopFilter(async (stop) => {
      for (let addr = 0x3000; addr < 0x3010; addr += 4) {
        if (await stop.read(addr, 4)) reads++
      }
      return true
    })
    server.hitBreakpoint(BP)
    await settle()
    expect(reads).toBe(4)
    expect(paused).not.toContain(true)
    expect(hostGdb.getSnapshot().paused).toBe(false)
    expect(server.running).toBe(true)
  })

  it('publishes a stop it keeps, once it has answered', async () => {
    const server = await attached()
    let pausedWhileAsked: boolean | null = null
    hostGdb.setStopFilter(async (stop) => {
      await stop.read(0x3000, 4)
      pausedWhileAsked = hostGdb.getSnapshot().paused
      return false
    })
    server.hitBreakpoint(BP)
    await vi.waitFor(() => {
      const snap = hostGdb.getSnapshot()
      expect(snap.paused && !snap.registersLoading && snap.pc !== null).toBe(true)
    })
    expect(pausedWhileAsked).toBe(false)
    expect(server.running).toBe(false)
  })

  it('leaves the machine stopped when Pause lands while it is still deciding', async () => {
    const server = await attached()
    let answer!: (reject: boolean) => void
    hostGdb.setStopFilter(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    )
    server.hitBreakpoint(BP)
    await settle()
    await hostGdb.pause()
    const mark = server.packets.length
    answer(true) // "not this one", but the reader asked to stop in the meantime
    await settle()
    expect(server.packets.slice(mark).filter((p) => p.startsWith('vCont'))).toEqual([])
    expect(server.running).toBe(false)
    expect(hostGdb.getSnapshot().paused).toBe(true)
  })

  it('keeps the stop when it throws, rather than leave a frozen guest unexplained', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const server = await attached()
    hostGdb.setStopFilter(async () => {
      throw new Error('broken filter')
    })
    server.hitBreakpoint(BP)
    await vi.waitFor(() => expect(hostGdb.getSnapshot().paused).toBe(true))
    expect(server.running).toBe(false)
  })

  it('refuses a read made after the stop was let go, instead of sending it to a running stub', async () => {
    const server = await attached()
    let read: hostGdb.StopContext['read'] | null = null
    hostGdb.setStopFilter((stop) => {
      read = stop.read
      return true
    })
    server.hitBreakpoint(BP)
    await settle()
    expect(server.running).toBe(true)
    const mark = server.packets.length
    // QEMU's stub stops the vCPU on any byte that arrives mid-run, silently.
    expect(await read!(0x3000, 4)).toBeNull()
    expect(server.packets.slice(mark)).toEqual([])
  })
})
