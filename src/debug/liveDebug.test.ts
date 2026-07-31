/**
 * The live debug controller end to end: a fake WebSocket plays the daemon
 * (ctrl gdb-attach handling and a FakeRspServer behind CH_GDB), and the
 * production stack — probe client, bridge transport, RspClient, hostGdb —
 * runs unchanged between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridge from '@/probe/client'
import * as bridgeStore from '@/lib/bridgeStore'
import * as hostGdb from '@/hostGdb'
import * as liveDebug from '@/debug/liveDebug'
import {
  CH_CTRL,
  CH_GDB,
  decodeCtrl,
  decodeFrame,
  encodeCtrl,
  encodeFrame,
} from '@/probe/protocol'
import { FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'
import type { RspTransport } from '@/debug/gdb/rspTransport'

class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

/** The daemon: gdb-attach ctrl flow plus an RSP server behind CH_GDB. */
class FakeBridgeWs {
  static instances: FakeBridgeWs[] = []
  url: string
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  server = new FakeRspServer()
  attachOutcome: 'connected' | 'error' = 'connected'
  attachDetail = ''
  gdbAttached = false
  ctrlSent: Array<Record<string, unknown>> = []
  private serverT: RspTransport

  constructor(url: string) {
    this.url = url
    FakeBridgeWs.instances.push(this)
    this.serverT = this.server.transport()
    this.serverT.setOnData?.(() => this.pumpGdb())
  }

  send(data: Uint8Array) {
    const frame = decodeFrame(data)
    if (!frame) return
    if (frame.channel === CH_GDB) {
      if (!this.gdbAttached) return
      let text = ''
      for (let i = 0; i < frame.payload.length; i++) {
        text += String.fromCharCode(frame.payload[i]!)
      }
      this.serverT.send(text)
      this.pumpGdb()
      return
    }
    if (frame.channel === CH_CTRL) {
      const msg = decodeCtrl(frame.payload) as Record<string, unknown>
      this.ctrlSent.push(msg)
      if (msg.type === 'gdb-attach') {
        // Deferred like real I/O; the daemon rebroadcasts idle (its internal
        // detach) before the outcome.
        queueMicrotask(() => {
          this.emitGdbStatus('idle', '')
          if (this.attachOutcome === 'connected') {
            this.gdbAttached = true
            this.emitGdbStatus('connected', '')
          } else {
            this.emitGdbStatus('error', this.attachDetail || 'connection refused')
          }
        })
      }
      if (msg.type === 'gdb-detach') this.gdbAttached = false
    }
  }

  emitGdbStatus(phase: string, detail: string) {
    this.emit(encodeCtrl({ type: 'gdb-status', host: '127.0.0.1', port: 3333, phase, detail }))
  }

  private pumpGdb() {
    const out = this.serverT.drain()
    if (out.length) this.emit(encodeFrame(CH_GDB, out))
  }

  private emit(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer })
  }

  close() {
    this.readyState = 3
  }

  emitOpen() {
    this.readyState = 1
    this.onopen?.()
  }

  emitClose(code = 1006) {
    this.onclose?.({ code, reason: '' })
  }
}

const lastWs = () => FakeBridgeWs.instances[FakeBridgeWs.instances.length - 1]!

async function microtasks(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  FakeBridgeWs.instances = []
  bridge._resetForTests()
  bridge.setWsFactoryForTests((u) => new FakeBridgeWs(u) as unknown as WebSocket)
  localStorage.setItem(
    'zephyr.bridge',
    JSON.stringify({ v: 1, enabled: true, url: 'ws://bridge.local:8740/?token=t' }),
  )
  bridgeStore.reloadFromStorage()
  bridge.startBridgeClient()
  lastWs().emitOpen()
})

afterEach(() => {
  liveDebug._resetForTests()
  hostGdb.detach()
  bridge._resetForTests()
  bridge.setWsFactoryForTests(null)
  vi.unstubAllGlobals()
})

describe('liveDebug controller', () => {
  it('attaches through the daemon and ends up running', async () => {
    liveDebug.setLiveMode(true)
    expect(liveDebug.getSnapshot().phase).toBe('idle')
    expect(hostGdb.getSnapshot().source).toBe('bridge')

    await liveDebug.attach()
    await microtasks()

    const snap = liveDebug.getSnapshot()
    expect(snap.phase).toBe('attached')
    expect(snap.pageInitiated).toBe(true)
    expect(hostGdb.getSnapshot().attached).toBe(true)
    expect(hostGdb.getSnapshot().paused).toBe(false)
    expect(lastWs().server.running).toBe(true)
    expect(lastWs().server.missingAcks).toBe(0)
  })

  it('surfaces the daemon rejection verbatim', async () => {
    liveDebug.setLiveMode(true)
    const ws = lastWs()
    ws.attachOutcome = 'error'
    ws.attachDetail = 'gdb server rejected the session — target not examined (check SWD link/power)'

    await liveDebug.attach()
    const snap = liveDebug.getSnapshot()
    expect(snap.phase).toBe('error')
    expect(snap.detail).toContain('target not examined')
    expect(hostGdb.getSnapshot().attached).toBe(false)
  })

  it('adopts a TUI-initiated proxy and leaves it up on detach', async () => {
    liveDebug.setLiveMode(true)
    const ws = lastWs()
    ws.gdbAttached = true
    ws.emitGdbStatus('connected', '')

    await liveDebug.attach()
    expect(liveDebug.getSnapshot().phase).toBe('attached')
    expect(liveDebug.getSnapshot().pageInitiated).toBe(false)
    expect(ws.ctrlSent.some((m) => m.type === 'gdb-attach')).toBe(false)

    await liveDebug.detachSession()
    expect(liveDebug.getSnapshot().phase).toBe('idle')
    expect(ws.ctrlSent.some((m) => m.type === 'gdb-detach')).toBe(false)
    expect(ws.gdbAttached).toBe(true)
  })

  it('detach clears page breakpoints, resumes the board and hangs up', async () => {
    liveDebug.setLiveMode(true)
    await liveDebug.attach()
    const ws = lastWs()

    expect(await hostGdb.addBreakpoint(0x2000_0100)).toBe(true)
    expect(ws.server.swBreakpoints.has(0x2000_0100)).toBe(true)

    await liveDebug.detachSession()
    expect(liveDebug.getSnapshot().phase).toBe('idle')
    expect(ws.server.swBreakpoints.size).toBe(0)
    expect(ws.server.running).toBe(true)
    expect(ws.gdbAttached).toBe(false)
    expect(hostGdb.getSnapshot().attached).toBe(false)
    expect(hostGdb.getSnapshot().available).toBe(true)
  })

  it('tears down locally when the bridge drops mid-session', async () => {
    liveDebug.setLiveMode(true)
    await liveDebug.attach()
    expect(liveDebug.getSnapshot().phase).toBe('attached')

    const ws = lastWs()
    ws.emitClose()

    const snap = liveDebug.getSnapshot()
    expect(snap.phase).toBe('error')
    expect(snap.detail).toContain('Bridge connection lost')
    const gdb = hostGdb.getSnapshot()
    expect(gdb.attached).toBe(false)
    expect(gdb.available).toBe(true)
    expect(gdb.source).toBe('bridge')
  })
})
