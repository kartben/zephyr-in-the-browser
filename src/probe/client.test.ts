/**
 * Trace-decoder ownership. The bridge may be connected in either session
 * mode, but it owns hostTrace only in Live board mode — a Simulator session
 * keeps it around for Bridge network without blanking the guest's Trace
 * panel (the original seizure bug).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hostTrace from '@/hostTrace'
import * as bridgeStore from '@/lib/bridgeStore'
import * as modeStore from '@/lib/modeStore'
import * as bridge from '@/probe/client'
import { CH_CTF, encodeFrame } from '@/probe/protocol'

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

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0
  binaryType = 'blob'
  bufferedAmount = 0
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: Uint8Array) {
    this.sent.push(data.slice())
  }
  close() {
    this.readyState = 3
  }
  emitOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  emitMessage(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.slice().buffer })
  }
}

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  FakeWebSocket.instances = []
  bridge._resetForTests()
  bridge.setWsFactoryForTests((u) => new FakeWebSocket(u) as unknown as WebSocket)
  localStorage.setItem(
    'zephyr.bridge',
    JSON.stringify({ v: 1, enabled: true, url: 'ws://bridge.local:8740/?token=t' }),
  )
  bridgeStore.reloadFromStorage()
  modeStore.reloadFromStorage()
})

afterEach(() => {
  bridge._resetForTests()
  bridge.setWsFactoryForTests(null)
  hostTrace.endExternal()
  vi.unstubAllGlobals()
})

describe('bridge trace ownership', () => {
  it('leaves the decoder alone in a Simulator session, still counting bytes', () => {
    bridge.startBridgeClient()
    const ws = lastWs()
    ws.emitOpen()
    expect(bridge.getSnapshot().phase).toBe('connected')
    expect(hostTrace.getSnapshot().source).toBeNull()

    ws.emitMessage(encodeFrame(CH_CTF, new Uint8Array([1, 2, 3])))
    expect(hostTrace.getSnapshot().source).toBeNull()
    expect(bridge.getSnapshot().ctfBytes).toBe(3)
  })

  it('owns the decoder in a Live board session', () => {
    modeStore.setMode('live')
    bridge.startBridgeClient()
    lastWs().emitOpen()
    const snap = hostTrace.getSnapshot()
    expect(snap.source).toBe('bridge')
    expect(snap.following).toBe(true)
  })

  it('follows a mode flip while connected', () => {
    bridge.startBridgeClient()
    lastWs().emitOpen()
    expect(hostTrace.getSnapshot().source).toBeNull()

    modeStore.setMode('live')
    expect(hostTrace.getSnapshot().source).toBe('bridge')

    modeStore.setMode('sim')
    expect(hostTrace.getSnapshot().source).toBeNull()
  })

  it('releases the decoder on disconnect', () => {
    modeStore.setMode('live')
    bridge.startBridgeClient()
    lastWs().emitOpen()
    expect(hostTrace.getSnapshot().source).toBe('bridge')

    bridge.disconnect()
    expect(hostTrace.getSnapshot().source).toBeNull()
  })
})
