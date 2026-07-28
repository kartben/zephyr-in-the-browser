import { describe, expect, it } from 'vitest'
import { decodeFields, makeEventDef, parseMetadata } from './metadata'
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

describe('parseMetadata bounded strings', () => {
  it('keeps thread names at 20 bytes and socket addresses at 46', () => {
    const text = `
event {
	name = thread_switched_in;
	id = 0x11;
	fields := struct {
		uint32_t thread_id;
		ctf_bounded_string_t name[20];
	};
};
event {
	name = socket_bind_enter;
	id = 0x3B;
	fields := struct {
		uint32_t id;
		ctf_bounded_string_t address[46];
		uint32_t address_length;
		uint16_t port;
	};
};
`
    const defs = parseMetadata(text)
    expect(defs.get(0x11)?.size).toBe(24)
    expect(defs.get(0x3b)?.size).toBe(4 + 46 + 4 + 2)
    expect(defs.get(0x3b)?.fields[1]).toEqual({ name: 'address', kind: { str: 46 } })
  })

  it('defaults omitted string width to 20', () => {
    const text = `
event {
	name = named_event;
	id = 0x62;
	fields := struct {
		ctf_bounded_string_t name;
		uint32_t arg0;
	};
};
`
    const defs = parseMetadata(text)
    expect(defs.get(0x62)?.fields[0]).toEqual({ name: 'name', kind: { str: 20 } })
    expect(defs.get(0x62)?.size).toBe(24)
  })
})

describe('address[46] decode does not desync following events', () => {
  it('decodes socket_bind_enter then thread_switched_in', () => {
    const bind = makeEventDef(0x3b, 'socket_bind_enter', [
      ['id', 'uint32_t'],
      ['address', { str: 46 }],
      ['address_length', 'uint32_t'],
      ['port', 'uint16_t'],
    ])
    const swin = makeEventDef(0x11, 'thread_switched_in', [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
    ])
    const defs = new Map([
      [0x3b, bind],
      [0x11, swin],
    ])
    expect(bind.size).toBe(56)

    const body = [
      ...encU32(3),
      ...encStr('192.0.2.1', 46),
      ...encU32(16),
      ...encU16(5001),
    ]
    expect(body.length).toBe(56)

    const bytes = Uint8Array.from([
      ...record(1000, 0x3b, body),
      ...record(2000, 0x11, [...encU32(0x1000), ...encStr('zperf_tx', 20)]),
    ])
    const reader = new TraceReader(defs)
    expect(reader.feed(bytes)).toBe(2)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events[0]?.fields.address).toBe('192.0.2.1')
    expect(reader.tr.events[0]?.fields.port).toBe(5001)
    expect(reader.tr.events[1]?.name).toBe('thread_switched_in')
    expect(reader.tr.events[1]?.fields.name).toBe('zperf_tx')
  })

  it('wrong 20-byte assumption would scramble the next record', () => {
    // Document the bug Phase 0 fixed: treating address as str20 leaves 26
    // unread bytes that poison the following header.
    const wrong = makeEventDef(0x3b, 'socket_bind_enter', [
      ['id', 'uint32_t'],
      ['address', 'str20'],
      ['address_length', 'uint32_t'],
      ['port', 'uint16_t'],
    ])
    expect(wrong.size).toBe(30)
    const buf = Uint8Array.from([
      ...encU32(3),
      ...encStr('192.0.2.1', 46),
      ...encU32(16),
      ...encU16(5001),
    ])
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const { next } = decodeFields(wrong, buf, 0, view)
    expect(next).toBe(30)
    expect(next).not.toBe(56)
  })
})
