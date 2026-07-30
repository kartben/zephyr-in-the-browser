import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FramingError,
  StreamFramer,
  UplinkSink,
  WIRE_HDR,
  trimEthernetPadding,
  type UplinkHooks,
} from './uplink'

/** 60-byte frame as the guest NIC pads it: IPv4, tot_len 40, 6 pad octets. */
function paddedIpv4Frame(totLen = 40): Uint8Array {
  const f = new Uint8Array(60).fill(0x11)
  f[12] = 0x08
  f[13] = 0x00
  f[14] = 0x45
  f[16] = (totLen >> 8) & 0xff
  f[17] = totLen & 0xff
  return f
}

function prefixed(...frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((n, f) => n + WIRE_HDR + f.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const f of frames) {
    out[off] = (f.length >>> 24) & 0xff
    out[off + 1] = (f.length >>> 16) & 0xff
    out[off + 2] = (f.length >>> 8) & 0xff
    out[off + 3] = f.length & 0xff
    out.set(f, off + WIRE_HDR)
    off += WIRE_HDR + f.length
  }
  return out
}

function frameOf(len: number, fill = 0xab): Uint8Array {
  return new Uint8Array(len).fill(fill)
}

describe('StreamFramer', () => {
  it('yields one frame from one chunk', () => {
    const framer = new StreamFramer()
    const f = frameOf(60)
    const out = framer.push(prefixed(f))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(f)
  })

  it('yields two frames from one chunk', () => {
    const framer = new StreamFramer()
    const out = framer.push(prefixed(frameOf(14, 1), frameOf(100, 2)))
    expect(out.map((f) => f.length)).toEqual([14, 100])
    expect(out[0][0]).toBe(1)
    expect(out[1][0]).toBe(2)
  })

  it('reassembles a frame split mid-header and mid-payload', () => {
    const framer = new StreamFramer()
    const f = frameOf(300, 7)
    const wire = prefixed(f)
    expect(framer.push(wire.subarray(0, 2))).toHaveLength(0) // half the length prefix
    expect(framer.push(wire.subarray(2, 150))).toHaveLength(0) // partial payload
    const out = framer.push(wire.subarray(150))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(f)
  })

  it('handles empty chunks and frames straddling message boundaries', () => {
    const framer = new StreamFramer()
    const a = frameOf(20, 3)
    const b = frameOf(40, 4)
    const wire = prefixed(a, b)
    expect(framer.push(new Uint8Array(0))).toHaveLength(0)
    const first = framer.push(wire.subarray(0, WIRE_HDR + 20 + 2))
    expect(first).toHaveLength(1)
    const second = framer.push(wire.subarray(WIRE_HDR + 20 + 2))
    expect(second).toHaveLength(1)
    expect(second[0]).toEqual(b)
  })

  it('passes the oversize band through for the client to count', () => {
    const framer = new StreamFramer()
    const out = framer.push(prefixed(frameOf(2048)))
    expect(out[0].length).toBe(2048)
  })

  it('throws FramingError on runt and absurd lengths', () => {
    for (const len of [0, 13, 2049]) {
      const framer = new StreamFramer()
      const wire = new Uint8Array(WIRE_HDR)
      wire[0] = (len >>> 24) & 0xff
      wire[1] = (len >>> 16) & 0xff
      wire[2] = (len >>> 8) & 0xff
      wire[3] = len & 0xff
      expect(() => framer.push(wire)).toThrow(FramingError)
    }
    const framer = new StreamFramer()
    expect(() => framer.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow(FramingError)
  })

  it('reset() drops buffered bytes', () => {
    const framer = new StreamFramer()
    framer.push(prefixed(frameOf(50)).subarray(0, 10))
    framer.reset()
    expect(framer.push(prefixed(frameOf(14)))).toHaveLength(1)
  })
})

describe('trimEthernetPadding', () => {
  it('trims a 60-byte padded frame to header + IP total length', () => {
    const out = trimEthernetPadding(paddedIpv4Frame(40))
    expect(out).toHaveLength(54)
    expect(out).toEqual(paddedIpv4Frame(40).subarray(0, 54))
  })

  it('leaves exact-length frames alone', () => {
    const f = paddedIpv4Frame(46) // 14 + 46 = 60: nothing to trim
    expect(trimEthernetPadding(f)).toBe(f)
  })

  it('ignores non-IPv4 ethertypes even at padded sizes', () => {
    const arp = paddedIpv4Frame(40)
    arp[12] = 0x08
    arp[13] = 0x06
    expect(trimEthernetPadding(arp)).toBe(arp)
  })

  it('ignores runts and frames whose claimed length is implausible', () => {
    expect(trimEthernetPadding(new Uint8Array(20))).toHaveLength(20)
    const tooShort = paddedIpv4Frame(8) // tot_len below an IPv4 header
    expect(trimEthernetPadding(tooShort)).toBe(tooShort)
    const tooLong = paddedIpv4Frame(200) // claims more than the frame holds
    expect(trimEthernetPadding(tooLong)).toBe(tooLong)
  })
})

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
    // A real ArrayBuffer, exactly what binaryType='arraybuffer' delivers.
    this.onmessage?.({ data: bytes.slice().buffer })
  }
  emitClose(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function makeSink(url = 'ws://gw.local:8737/') {
  const delivered: Uint8Array[] = []
  const hooks: UplinkHooks = {
    deliverFrame: (f) => delivered.push(f),
    onPhaseChange: vi.fn(),
    onChange: vi.fn(),
  }
  const sink = new UplinkSink(url, hooks, {
    wsFactory: (u) => new FakeWebSocket(u) as unknown as WebSocket,
  })
  return { sink, hooks, delivered }
}

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('UplinkSink', () => {
  it('walks idle → connecting → connected and configures the socket', () => {
    const { sink } = makeSink()
    expect(sink.phase).toBe('idle')
    sink.connect()
    expect(sink.phase).toBe('connecting')
    const ws = lastWs()
    expect(ws.url).toBe('ws://gw.local:8737/')
    expect(ws.binaryType).toBe('arraybuffer')
    ws.emitOpen()
    expect(sink.phase).toBe('connected')
  })

  it('sends one length-prefixed message per guest frame', () => {
    const { sink } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    const frame = frameOf(60, 0x42)
    sink.onGuestFrame(frame)
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toEqual(prefixed(frame))
  })

  it('drops and counts guest frames while not connected', () => {
    const { sink, hooks } = makeSink()
    sink.connect()
    sink.onGuestFrame(frameOf(60))
    expect(sink.counters.droppedTx).toBe(1)
    expect(lastWs().sent).toHaveLength(0)
    expect(hooks.onChange).toHaveBeenCalled()
  })

  it('drops instead of queueing when the socket buffer is saturated', () => {
    const { sink } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    ws.bufferedAmount = 2 << 20
    sink.onGuestFrame(frameOf(60))
    expect(ws.sent).toHaveLength(0)
    expect(sink.counters.droppedTx).toBe(1)
  })

  it('trims Ethernet padding from outbound IPv4 frames', () => {
    const { sink } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    sink.onGuestFrame(paddedIpv4Frame())
    expect(ws.sent).toHaveLength(1)
    expect(ws.sent[0]).toEqual(prefixed(paddedIpv4Frame().subarray(0, 54)))
  })

  it('delivers inbound frames unpadded and untrimmed', () => {
    const { sink, delivered } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    ws.emitMessage(prefixed(paddedIpv4Frame()))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toHaveLength(60)
  })

  it('reassembles inbound frames across message boundaries and delivers them', () => {
    const { sink, delivered } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    const a = frameOf(200, 5)
    const b = frameOf(64, 6)
    const wire = prefixed(a, b)
    ws.emitMessage(wire.subarray(0, 100))
    ws.emitMessage(wire.subarray(100))
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toEqual(a)
    expect(delivered[1]).toEqual(b)
  })

  it('counts oversize frames instead of delivering them, with an MTU hint', () => {
    const { sink, delivered } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    ws.emitMessage(prefixed(frameOf(1600)))
    expect(delivered).toHaveLength(0)
    expect(sink.counters.oversizeRx).toBe(1)
    expect(sink.detail).toContain('MTU')
  })

  it('treats a desynced stream as fatal: close, error, reconnect', () => {
    const { sink } = makeSink()
    sink.connect()
    const ws = lastWs()
    ws.emitOpen()
    ws.emitMessage(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
    expect(sink.phase).toBe('error')
    expect(ws.closed).toContain(4000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('backs off 500→1000→2000 and re-dials', () => {
    const { sink } = makeSink()
    sink.connect()
    lastWs().emitClose(1006)
    expect(sink.phase).toBe('error')
    vi.advanceTimersByTime(499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    lastWs().emitClose(1006)
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(sink.counters.attempts).toBe(3)
  })

  it('resets the backoff ladder after a stable connection', () => {
    const { sink } = makeSink()
    sink.connect()
    lastWs().emitClose(1006)
    vi.advanceTimersByTime(500)
    lastWs().emitOpen()
    vi.advanceTimersByTime(5000) // the stable window
    expect(sink.counters.attempts).toBe(0)
    lastWs().emitClose(1006)
    vi.advanceTimersByTime(500) // back to the first rung
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('maps the gateway close codes to readable details', () => {
    const { sink } = makeSink()
    sink.connect()
    lastWs().emitClose(4001)
    expect(sink.detail).toContain('token')
    expect(sink.detail).toContain('4001')
  })

  it('disconnect() stays down: no reconnect timer fires', () => {
    const { sink } = makeSink()
    sink.connect()
    lastWs().emitOpen()
    sink.disconnect()
    expect(sink.phase).toBe('closed')
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('connect() after disconnect() dials again', () => {
    const { sink } = makeSink()
    sink.connect()
    sink.disconnect()
    sink.connect()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(sink.phase).toBe('connecting')
  })

  it('ignores events from a socket it already disposed', () => {
    const { sink, hooks } = makeSink()
    sink.connect()
    const ws = lastWs()
    sink.dispose()
    const callsBefore = vi.mocked(hooks.onPhaseChange).mock.calls.length
    ws.emitOpen()
    ws.emitClose(1006)
    expect(vi.mocked(hooks.onPhaseChange).mock.calls.length).toBe(callsBefore)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('rejects an empty or non-ws URL without dialing or retrying', () => {
    for (const [url, detail] of [
      ['', 'set a gateway URL'],
      ['http://gw.local/', 'not a ws:// or wss:// URL'],
    ] as const) {
      FakeWebSocket.instances = []
      const { sink } = makeSink(url)
      sink.connect()
      expect(sink.phase).toBe('error')
      expect(sink.detail).toBe(detail)
      vi.advanceTimersByTime(60_000)
      expect(FakeWebSocket.instances).toHaveLength(0)
    }
  })

  it('learns the guest identity from TX frames via the sniffer', () => {
    const { sink, hooks } = makeSink()
    sink.connect()
    lastWs().emitOpen()
    // A minimal Ethernet frame with a unicast source teaches the MAC.
    const frame = frameOf(60, 0)
    frame.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0)
    frame.set([0x02, 0, 0, 0, 0, 1], 6)
    sink.onGuestFrame(frame)
    expect(sink.sniff.guestMac).toEqual(Uint8Array.of(0x02, 0, 0, 0, 0, 1))
    expect(hooks.onChange).toHaveBeenCalled()
  })
})
