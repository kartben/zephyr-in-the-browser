/**
 * The production RspClient against a server with OpenOCD's manners — the
 * Live board path end to end minus the WebSocket. The QEMU-flavored rules
 * live in rspClient.test.ts; nothing here loosens them, because every
 * OpenOCD behavior is opt-in via RspClientOptions.
 */

import { describe, expect, it } from 'vitest'
import { RspClient, type RspClientOptions } from '@/debug/gdb/rspClient'
import { FakeRspServer, type FakeRspServerOptions } from '@/debug/gdb/testing/fakeRspServer'

const BRIDGE_OPTS: RspClientOptions = {
  eagerAcks: true,
  probeVCont: true,
  hwBreakpointFallback: true,
  resolveUnknownStop: true,
}

function rig(serverOpts: FakeRspServerOptions = {}) {
  const server = new FakeRspServer(serverOpts)
  const client = new RspClient(server.transport(), BRIDGE_OPTS)
  return { server, client }
}

/** Drive the client's poll the way hostGdb's 20 ms timer does. */
async function settle(client: RspClient, ticks = 60) {
  for (let i = 0; i < ticks; i++) {
    client.poll()
    await Promise.resolve()
  }
}

describe('RspClient with OpenOCD options', () => {
  it('acks every reply while ack mode lasts, then negotiates no-ack', async () => {
    const { server, client } = rig()
    const started = client.start()
    await settle(client)
    const stop = await started
    expect(stop?.raw).toContain('T05')
    expect(server.noAck).toBe(true)
    expect(server.missingAcks).toBe(0)
  })

  it('falls back to bare c/s when the target lacks vCont', async () => {
    const { server, client } = rig({ supportsVCont: false })
    const started = client.start()
    await settle(client)
    await started
    await client.continue()
    expect(server.running).toBe(true)
    expect(server.packets).toContain('vCont?')
    expect(server.packets).toContain('c')
    expect(server.packets).not.toContain('vCont;c')
  })

  it('keeps vCont when the probe answers positively', async () => {
    const { server, client } = rig()
    const started = client.start()
    await settle(client)
    await started
    await client.continue()
    expect(server.packets).toContain('vCont;c')
  })

  it('halts an adopted running target instead of trusting S00', async () => {
    const { server, client } = rig({ startRunning: true })
    const started = client.start()
    await settle(client)
    const stop = await started
    expect(server.breaks).toBe(1)
    expect(server.running).toBe(false)
    expect(stop?.raw).toContain('T02')
    expect(client.isRunning()).toBe(false)
  })

  it('does not let console output resolve a pending request', async () => {
    const { server, client } = rig()
    const started = client.start()
    await settle(client)
    await started
    // Prose arrives ahead of the register reply; the waiter must skip it.
    server.emitConsole('halted due to debug-request\n')
    const regsPromise = client.readRegisters()
    await settle(client)
    const regs = await regsPromise
    expect(regs).toMatch(/^[0-9a-f]+$/)
    expect(regs.length).toBe(17 * 4 * 2)
    // 'OK' replies still resolve normally (they are not console output).
    const writePromise = client.writeMemory(0x2000_0000, new Uint8Array([1, 2]))
    await settle(client)
    await expect(writePromise).resolves.toBeUndefined()
  })

  it('plants a hardware breakpoint when Z0 fails in flash, and removes it as one', async () => {
    const flash = { start: 0x0800_0000, end: 0x0810_0000 }
    const { server, client } = rig({ flashRange: flash })
    const started = client.start()
    await settle(client)
    await started

    const insert = client.insertSwBreakpoint(0x0800_1234, 2)
    await settle(client)
    expect(await insert).toBe(true)
    expect(server.hwBreakpoints.has(0x0800_1234)).toBe(true)
    expect(server.swBreakpoints.has(0x0800_1234)).toBe(false)

    const remove = client.removeSwBreakpoint(0x0800_1234, 2)
    await settle(client)
    expect(await remove).toBe(true)
    expect(server.hwBreakpoints.has(0x0800_1234)).toBe(false)
    // RAM addresses still use plain software breakpoints.
    const ram = client.insertSwBreakpoint(0x2000_0100, 2)
    await settle(client)
    expect(await ram).toBe(true)
    expect(server.swBreakpoints.has(0x2000_0100)).toBe(true)
  })

  it('surfaces a breakpoint hit through the stop handler', async () => {
    const { server, client } = rig()
    const started = client.start()
    await settle(client)
    await started
    const stops: string[] = []
    client.setStopHandler((info) => stops.push(info.raw))
    await client.continue()
    expect(server.running).toBe(true)
    server.hitBreakpoint(0x2000)
    await settle(client)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain('T05')
    expect(client.isRunning()).toBe(false)
  })
})
