/**
 * The live session core against the fake OpenOCD server: bindLive publishes
 * availability with no wasm module, attachLiveSession runs the full attach
 * (halt on open, resume so the board is not left frozen), and detachLive
 * returns to bound-but-unattached without losing the parsed image.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as hostGdb from '@/hostGdb'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'

afterEach(() => {
  hostGdb.detach()
})

describe('hostGdb live sessions', () => {
  it('bindLive makes the debugger available with a bridge source', () => {
    hostGdb.bindLive('arm')
    const snap = hostGdb.getSnapshot()
    expect(snap.available).toBe(true)
    expect(snap.source).toBe('bridge')
    expect(snap.attached).toBe(false)
    expect(snap.regArch).toBe('arm')
  })

  it('attaches over the bridge transport and resumes past the attach halt', async () => {
    hostGdb.bindLive('arm')
    const server = new FakeRspServer()
    const ok = await hostGdb.attachLiveSession(server.transport())
    expect(ok).toBe(true)
    const snap = hostGdb.getSnapshot()
    expect(snap.attached).toBe(true)
    expect(snap.paused).toBe(false)
    expect(server.running).toBe(true)
    expect(server.missingAcks).toBe(0)
    expect(hostGdb.sessionActive()).toBe(true)
  })

  it('pause and resume drive the board through the live client', async () => {
    hostGdb.bindLive('arm')
    const server = new FakeRspServer()
    await hostGdb.attachLiveSession(server.transport())

    await hostGdb.pause()
    expect(hostGdb.getSnapshot().paused).toBe(true)
    expect(server.running).toBe(false)

    await hostGdb.resume()
    expect(hostGdb.getSnapshot().paused).toBe(false)
    expect(server.running).toBe(true)
  })

  it('refuses to attach without bindLive', async () => {
    const server = new FakeRspServer()
    expect(await hostGdb.attachLiveSession(server.transport())).toBe(false)
  })

  it('detachLive returns to bound-but-unattached and allows a re-attach', async () => {
    hostGdb.bindLive('arm')
    await hostGdb.attachLiveSession(new FakeRspServer().transport())
    expect(hostGdb.getSnapshot().attached).toBe(true)

    hostGdb.detachLive()
    const snap = hostGdb.getSnapshot()
    expect(snap.attached).toBe(false)
    expect(snap.available).toBe(true)
    expect(snap.source).toBe('bridge')

    const again = new FakeRspServer()
    expect(await hostGdb.attachLiveSession(again.transport())).toBe(true)
    expect(again.running).toBe(true)
  })

  it('setLiveArch retargets the register decode for live sessions only', () => {
    hostGdb.bindLive(null)
    expect(hostGdb.getSnapshot().regArch).toBe('arm')
    hostGdb.setLiveArch('riscv32')
    expect(hostGdb.getSnapshot().regArch).toBe('riscv32')
    hostGdb.detach()
    hostGdb.setLiveArch('aarch64')
    expect(hostGdb.getSnapshot().regArch).toBeNull()
  })
})
