import { describe, expect, it } from 'vitest'
import { makeEventDef } from './metadata'
import {
  formatByteCount,
  reconstructNetCore,
  reconstructSockets,
  socketKindLabel,
  socketLabel,
  socketWindowStats,
} from './netSockets'
import { TraceReader } from './reader'

function encU16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}
function encI32(n: number): number[] {
  return encU32(n >>> 0)
}
function encU64(n: number): number[] {
  const out = Array.from({ length: 8 }, () => 0)
  let x = n
  for (let i = 0; i < 8; i++) {
    out[i] = x & 0xff
    x = Math.floor(x / 256)
  }
  return out
}
function encStr(s: string, width: number): number[] {
  const out = Array.from({ length: width }, () => 0)
  for (let i = 0; i < Math.min(width, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

/** Minimal socket/net defs for unit tests (ids match Zephyr TSDL). */
function socketDefs() {
  const defs = [
    makeEventDef(0x36, 'socket_init', [
      ['id', 'uint32_t'],
      ['family', 'uint32_t'],
      ['type', 'uint32_t'],
      ['proto', 'uint32_t'],
    ]),
    makeEventDef(0x3b, 'socket_bind_enter', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
      ['port', 'uint16_t'],
    ]),
    makeEventDef(0x3d, 'socket_connect_enter', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
    ]),
    makeEventDef(0x3e, 'socket_connect_exit', [
      ['id', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x43, 'socket_sendto_enter', [
      ['id', 'uint32_t'],
      ['data_length', 'uint32_t'],
      ['flags', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
    ]),
    makeEventDef(0x44, 'socket_sendto_exit', [
      ['id', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x47, 'socket_recvfrom_enter', [
      ['id', 'uint32_t'],
      ['max_length', 'uint32_t'],
      ['flags', 'uint32_t'],
      ['address', 'uint32_t'],
      ['address_length', 'uint32_t'],
    ]),
    makeEventDef(0x48, 'socket_recvfrom_exit', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x38, 'socket_close_exit', [
      ['id', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x40, 'socket_listen_exit', [
      ['id', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x42, 'socket_accept_exit', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
      ['port', 'uint16_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x5e, 'net_send_data_enter', [
      ['if_index', 'int32_t'],
      ['iface', 'uint32_t'],
      ['pkt', 'uint32_t'],
      ['pkt_len', 'uint32_t'],
    ]),
    makeEventDef(0x5f, 'net_send_data_exit', [
      ['if_index', 'int32_t'],
      ['iface', 'uint32_t'],
      ['pkt', 'uint32_t'],
      ['result', 'int32_t'],
    ]),
    makeEventDef(0x61, 'net_tx_time', [
      ['if_index', 'int32_t'],
      ['iface', 'uint32_t'],
      ['pkt', 'uint32_t'],
      ['priority', 'uint32_t'],
      ['traffic_class', 'uint32_t'],
      ['duration_us', 'uint32_t'],
    ]),
  ]
  return new Map(defs.map((d) => [d.eid, d]))
}

describe('reconstructSockets', () => {
  it('tracks UDP init→bind→sendto→recvfrom→close with byte totals', () => {
    const reader = new TraceReader(socketDefs())
    const fd = 3
    reader.feed(
      Uint8Array.from([
        ...record(100, 0x36, [...encU32(fd), ...encU32(2), ...encU32(2), ...encU32(17)]),
        ...record(200, 0x3b, [...encU32(fd), ...encStr('0.0.0.0', 46), ...encU32(16), ...encU16(5001)]),
        ...record(300, 0x43, [
          ...encU32(fd),
          ...encU32(1200),
          ...encU32(0),
          ...encStr('192.0.2.2', 46),
          ...encU32(16),
        ]),
        ...record(310, 0x44, [...encU32(fd), ...encI32(1200)]),
        ...record(400, 0x47, [...encU32(fd), ...encU32(1500), ...encU32(0), ...encU32(0), ...encU32(0)]),
        ...record(410, 0x48, [...encU32(fd), ...encStr('192.0.2.2', 46), ...encU32(16), ...encI32(800)]),
        ...record(500, 0x44, [...encU32(fd), ...encI32(-11)]), // orphan fail counts as error
        ...record(600, 0x38, [...encU32(fd), ...encI32(0)]),
      ]),
    )
    const series = reconstructSockets(reader.tr)
    expect(series).toHaveLength(1)
    const s = series[0]!
    expect(s.socket.fd).toBe(fd)
    expect(s.socket.state).toBe('closed')
    expect(s.socket.local).toEqual({ address: '0.0.0.0', port: 5001 })
    expect(s.socket.peer?.address).toBe('192.0.2.2')
    expect(s.txBytes).toBe(1200)
    expect(s.rxBytes).toBe(800)
    expect(s.errors).toBe(1)
    expect(socketKindLabel(s.socket.family, s.socket.type, s.socket.proto)).toBe('UDP4')
    expect(socketLabel(s)).toContain('fd 3')
    expect(socketLabel(s)).toContain('5001')

    const stats = socketWindowStats(series, 0, 1000)
    expect(stats).toEqual({ sockets: 1, txBytes: 1200, rxBytes: 800, errors: 1 })
  })

  it('opens a child series on accept and bumps generation on fd reuse', () => {
    const reader = new TraceReader(socketDefs())
    reader.feed(
      Uint8Array.from([
        ...record(10, 0x36, [...encU32(5), ...encU32(10), ...encU32(1), ...encU32(6)]),
        ...record(20, 0x40, [...encU32(5), ...encI32(0)]),
        ...record(30, 0x42, [
          ...encU32(5),
          ...encStr('2001:db8::2', 46),
          ...encU32(28),
          ...encU16(4242),
          ...encI32(7),
        ]),
        ...record(40, 0x38, [...encU32(5), ...encI32(0)]),
        // Reuse fd 5
        ...record(50, 0x36, [...encU32(5), ...encU32(2), ...encU32(2), ...encU32(17)]),
      ]),
    )
    const series = reconstructSockets(reader.tr)
    expect(series.map((s) => [s.socket.fd, s.socket.generation, s.socket.state])).toEqual([
      [5, 0, 'closed'],
      [7, 0, 'connected'],
      [5, 1, 'open'],
    ])
    expect(series[1]!.socket.peer).toEqual({ address: '2001:db8::2', port: 4242 })
    expect(socketKindLabel(10, 1, 6)).toBe('TCP6')
  })

  it('marks connect success and records peer from connect_enter', () => {
    const reader = new TraceReader(socketDefs())
    reader.feed(
      Uint8Array.from([
        ...record(1, 0x36, [...encU32(4), ...encU32(2), ...encU32(1), ...encU32(6)]),
        ...record(2, 0x3d, [...encU32(4), ...encStr('192.0.2.2', 46), ...encU32(16)]),
        ...record(3, 0x3e, [...encU32(4), ...encI32(0)]),
      ]),
    )
    const [s] = reconstructSockets(reader.tr)
    expect(s!.socket.state).toBe('connected')
    expect(s!.socket.peer?.address).toBe('192.0.2.2')
    expect(s!.samples.some((x) => x.op === 'connect' && x.ok)).toBe(true)
  })
})

describe('reconstructNetCore', () => {
  it('pairs send_data enter/exit and records tx_time latency', () => {
    const reader = new TraceReader(socketDefs())
    const pkt = 0xabcd
    reader.feed(
      Uint8Array.from([
        ...record(100, 0x5e, [...encI32(1), ...encU32(0x1000), ...encU32(pkt), ...encU32(512)]),
        ...record(110, 0x5f, [...encI32(1), ...encU32(0x1000), ...encU32(pkt), ...encI32(0)]),
        ...record(120, 0x61, [
          ...encI32(1),
          ...encU32(0x1000),
          ...encU32(pkt),
          ...encU32(0),
          ...encU32(0),
          ...encU32(42),
        ]),
      ]),
    )
    const [iface] = reconstructNetCore(reader.tr)
    expect(iface!.ifIndex).toBe(1)
    expect(iface!.txBytes).toBe(512)
    expect(iface!.samples.some((s) => s.dir === 'tx' && s.durationUs === 42)).toBe(true)
  })
})

describe('formatByteCount', () => {
  it('formats compact byte counts', () => {
    expect(formatByteCount(12)).toBe('12 B')
    expect(formatByteCount(1200)).toBe('1.20 KB')
    expect(formatByteCount(1_250_000)).toBe('1.25 MB')
  })
})
