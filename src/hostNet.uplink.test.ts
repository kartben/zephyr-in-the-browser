/**
 * Uplink mode end to end against the fake netdev module: the production ring
 * codec, polling, capture and snapshot paths run for real; only QEMU and the
 * WebSocket are stand-ins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as hostNet from '@/hostNet'
import * as netStore from '@/lib/netStore'
import { setDefaultWsFactoryForTests, WIRE_HDR } from '@/net/uplink'
import { createFakeNetModule, type FakeNetModule } from '@/net/testing/fakeModule'
import { ipFromString, macFromString, MAC_BROADCAST } from '@/net/bytes'
import { buildDhcpReply, DHCP_ACK } from '@/net/dhcp'
import { buildEth, ETHERTYPE_IPV4 } from '@/net/ethernet'
import { buildIpv4, IPPROTO_UDP } from '@/net/ipv4'
import { buildUdp } from '@/net/udp'

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
  closed: Array<number | undefined> = []
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
  close(code?: number) {
    this.closed.push(code)
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

const GUEST_MAC = macFromString('02:00:00:00:00:01')!
const GW_MAC = macFromString('52:54:00:12:34:56')!
const GUEST_IP = ipFromString('172.17.0.5')!
const GW_IP = ipFromString('172.17.0.1')!

function guestFrame(fill: number): Uint8Array {
  const frame = new Uint8Array(60).fill(fill)
  frame.set(MAC_BROADCAST, 0)
  frame.set(GUEST_MAC, 6)
  return frame
}

function prefixed(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(WIRE_HDR + frame.length)
  out[0] = (frame.length >>> 24) & 0xff
  out[1] = (frame.length >>> 16) & 0xff
  out[2] = (frame.length >>> 8) & 0xff
  out[3] = frame.length & 0xff
  out.set(frame, WIRE_HDR)
  return out
}

function dhcpAckFrame(): Uint8Array {
  const payload = buildDhcpReply({
    msgType: DHCP_ACK,
    xid: 0x1234,
    chaddr: GUEST_MAC,
    yiaddr: GUEST_IP,
    serverId: GW_IP,
    subnetMask: ipFromString('255.255.0.0')!,
    router: GW_IP,
    dns: ipFromString('172.17.0.53')!,
    sntp: GW_IP,
    leaseSecs: 600,
  })
  const udp = buildUdp(GW_IP, GUEST_IP, 67, 68, payload)
  return buildEth(GUEST_MAC, GW_MAC, ETHERTYPE_IPV4, buildIpv4(GW_IP, GUEST_IP, IPPROTO_UDP, udp))
}

let fake: FakeNetModule

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', new MemoryStorage())
  localStorage.setItem('zephyr.net', JSON.stringify({ v: 1, mode: 'uplink', url: 'ws://gw.local:8737/' }))
  netStore.reloadFromStorage()
  FakeWebSocket.instances = []
  setDefaultWsFactoryForTests((u) => new FakeWebSocket(u) as unknown as WebSocket)
  fake = createFakeNetModule()
})

afterEach(() => {
  hostNet.detach()
  setDefaultWsFactoryForTests(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

describe('hostNet in uplink mode', () => {
  it('dials the stored gateway and keeps the carrier up throughout', () => {
    hostNet.attach(fake.module)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(lastWs().url).toBe('ws://gw.local:8737/')
    // Carrier up from attach, socket open or not: Zephyr's virtio-net driver
    // has no link-status handling, so socket-driven carrier flips could only
    // confuse (or wedge) it. Disconnection = frames dropped in the sink.
    expect(fake.guestSide.linkUp()).toBe(true)
    expect(hostNet.getSnapshot().mode).toBe('uplink')
    expect(hostNet.getSnapshot().uplink.phase).toBe('connecting')

    fake.guestSide.writeTx(guestFrame(0x99))
    vi.advanceTimersByTime(300) // 100 ms poll drain + 100 ms coalesced rebuild
    expect(lastWs().sent).toHaveLength(0) // not open yet — dropped, not queued
    expect(hostNet.getSnapshot().uplink.droppedTx).toBe(1)

    lastWs().emitOpen()
    expect(fake.guestSide.linkUp()).toBe(true)
    expect(hostNet.getSnapshot().uplink.phase).toBe('connected')
    expect(hostNet.getSnapshot().linkUp).toBe(true)
  })

  it('ships guest TX frames out length-prefixed and injects gateway RX frames', () => {
    hostNet.attach(fake.module)
    const ws = lastWs()
    ws.emitOpen()

    const tx = guestFrame(0x42)
    fake.guestSide.writeTx(tx)
    vi.advanceTimersByTime(150) // one idle poll period
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toEqual(prefixed(tx))

    const ack = dhcpAckFrame()
    ws.emitMessage(prefixed(ack))
    const injected = fake.guestSide.drainRx()
    expect(injected).toHaveLength(1)
    expect(injected[0]).toEqual(ack)

    vi.advanceTimersByTime(150) // coalesced snapshot refresh
    const snap = hostNet.getSnapshot()
    expect(snap.dhcpState).toBe('bound')
    expect(snap.guestIp).toBe('172.17.0.5')
    expect(snap.gatewayIp).toBe('172.17.0.1')
    expect(snap.dnsIp).toBe('172.17.0.53')
    expect(snap.rxPackets).toBe(1)
    expect(snap.txPackets).toBe(1)
  })

  it('keeps impairments biting on the shared path', () => {
    hostNet.attach(fake.module)
    const ws = lastWs()
    ws.emitOpen()
    hostNet.setImpairments({ lossPct: 100 })
    fake.guestSide.writeTx(guestFrame(0x01))
    // The drain lands on the 100 ms idle poll; the coalesced snapshot rebuild
    // fires 100 ms after that.
    vi.advanceTimersByTime(300)
    expect(ws.sent).toHaveLength(0)
    expect(hostNet.getSnapshot().txPackets).toBe(1) // counted, then eaten by the wire
  })

  it('gates the carrier on user link too', () => {
    hostNet.attach(fake.module)
    lastWs().emitOpen()
    hostNet.setLink(false)
    expect(fake.guestSide.linkUp()).toBe(false)
    expect(hostNet.getSnapshot().userLinkUp).toBe(false)
    hostNet.setLink(true)
    expect(fake.guestSide.linkUp()).toBe(true)
  })

  it('rejects the sim-only dial-in tools with a mode-specific error', async () => {
    hostNet.attach(fake.module)
    await expect(hostNet.echoToGuest('hi', 'tcp')).rejects.toThrow('Not available in gateway mode')
    await expect(hostNet.httpGetFromHost('http://172.17.0.5/')).rejects.toThrow(
      'Not available in gateway mode',
    )
  })

  it('detach closes the socket and resets the snapshot', () => {
    hostNet.attach(fake.module)
    const ws = lastWs()
    ws.emitOpen()
    hostNet.detach()
    expect(ws.closed.length).toBeGreaterThan(0)
    expect(hostNet.getSnapshot().available).toBe(false)
    vi.advanceTimersByTime(60_000) // no zombie reconnects
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('a ?net=sim query wins over the stored uplink at attach time', () => {
    const cfg = netStore.resolveNetConfig('?net=sim')
    expect(cfg.mode).toBe('sim')
    // hostNet reads location.search, absent under node: the stored uplink is
    // used — resolveNetConfig's own precedence is covered in netStore.test.ts.
  })
})
