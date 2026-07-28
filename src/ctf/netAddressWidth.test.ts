import { describe, expect, it } from 'vitest'
import { makeEventDef } from './metadata'
import {
  applyNetAddressWidth,
  hasNetAddressField,
  probeNetAddressWidth,
  withNetAddressWidth,
} from './netAddressWidth'
import { TraceReader } from './reader'

function encU16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}
function encU32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
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

/** Metadata-shaped defs: bind address declared [46] (TSDL), switch uses str20. */
function defsTrustingTsdl() {
  const list = [
    makeEventDef(0x11, 'thread_switched_in', [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
    ]),
    makeEventDef(0x3b, 'socket_bind_enter', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
      ['port', 'uint16_t'],
    ]),
  ]
  return new Map(list.map((d) => [d.eid, d]))
}

describe('net address width helpers', () => {
  it('detects and rescales address[46] fields', () => {
    const def = makeEventDef(0x3b, 'socket_bind_enter', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['port', 'uint16_t'],
    ])
    expect(hasNetAddressField(def)).toBe(true)
    expect(def.size).toBe(4 + 46 + 2)
    expect(withNetAddressWidth(def, 20).size).toBe(4 + 20 + 2)
  })

  it('probes 20-byte guest layout when TSDL says 46', () => {
    const defs = defsTrustingTsdl()
    const bind = defs.get(0x3b)!
    // body: id + addr20 + len + port, then next header starts
    const bodyLen = 4 + 20 + 4 + 2
    const probed = probeNetAddressWidth(defs, bind, 0, bodyLen + 10, (nextOff) => {
      // Pretend next event is thread_switched_in at the narrow boundary.
      return nextOff === bodyLen ? 0x11 : 0xdead
    })
    expect(probed).toEqual({
      kind: 'width',
      width: 20,
      def: expect.objectContaining({ size: bodyLen }),
    })
  })
})

describe('TraceReader net address width', () => {
  it('used to desync: trusting [46] against a 20-byte guest kills later events', () => {
    // Reproduce the pre-fix failure mode without probing (locked wide layout).
    const defs = defsTrustingTsdl()
    applyNetAddressWidth(defs, 46)
    const reader = new TraceReader(defs)
    reader.netAddressWidth = 46 // skip probe; force metadata layout
    const bytes = Uint8Array.from([
      ...record(1000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(2000, 0x3b, [...encU32(3), ...encStr('192.0.2.1', 20), ...encU32(16), ...encU16(5001)]),
      ...record(3000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(4000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    reader.feed(bytes)
    // Mis-sized bind eats into the next records; a subsequent header looks unknown.
    expect(reader.desync).toBe(true)
    expect(reader.tr.events.filter((e) => e.name === 'thread_switched_in').length).toBe(1)
  })

  it('probes 20-byte addresses and keeps decoding Schedule after zperf-like binds', () => {
    const defs = defsTrustingTsdl()
    const reader = new TraceReader(defs)
    const bytes = Uint8Array.from([
      ...record(1000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(2000, 0x3b, [...encU32(3), ...encStr('192.0.2.1', 20), ...encU32(16), ...encU16(5001)]),
      ...record(3000, 0x11, [...encU32(0x2000), ...encStr('zperf_tx', 20)]),
      ...record(4000, 0x3b, [...encU32(4), ...encStr('0.0.0.0', 20), ...encU32(16), ...encU16(5001)]),
      ...record(5000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    expect(reader.feed(bytes)).toBe(5)
    expect(reader.desync).toBe(false)
    expect(reader.netAddressWidth).toBe(20)
    expect(reader.tr.events.map((e) => e.name)).toEqual([
      'thread_switched_in',
      'socket_bind_enter',
      'thread_switched_in',
      'socket_bind_enter',
      'thread_switched_in',
    ])
    expect(reader.tr.events[1]?.fields.address).toBe('192.0.2.1')
    expect(reader.tr.events[1]?.fields.port).toBe(5001)
  })

  it('probes 46-byte addresses when the guest has IPv6-sized CTF strings', () => {
    const defs = defsTrustingTsdl()
    const reader = new TraceReader(defs)
    const bytes = Uint8Array.from([
      ...record(1000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(2000, 0x3b, [
        ...encU32(3),
        ...encStr('2001:db8::1', 46),
        ...encU32(28),
        ...encU16(4242),
      ]),
      ...record(3000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    expect(reader.feed(bytes)).toBe(3)
    expect(reader.desync).toBe(false)
    expect(reader.netAddressWidth).toBe(46)
    expect(reader.tr.events[1]?.fields.address).toBe('2001:db8::1')
  })

  it('waits for a following header before locking width', () => {
    const defs = defsTrustingTsdl()
    const reader = new TraceReader(defs)
    // Bind body only — ambiguous until more bytes arrive.
    const partial = record(2000, 0x3b, [
      ...encU32(3),
      ...encStr('192.0.2.1', 20),
      ...encU32(16),
      ...encU16(5001),
      // Extra padding that looks like the start of a wide address field leftover
      // is NOT included — exact narrow body alone should wait (not lock) when
      // more data might still arrive… exact end locks narrow via probe.
    ])
    // Exact end-of-buffer with narrow size → probe locks 20 (no peek possible).
    reader.feed(partial)
    expect(reader.netAddressWidth).toBe(20)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events).toHaveLength(1)
  })
})
