import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeFields, fallbackDefs, makeEventDef, parseMetadata } from './metadata'
import { TraceReader } from './reader'
import * as types from './types'

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

  /*
   * An id the defs do not know is not a skipped event — CTF records here are
   * length-driven from the TSDL, so the reader cannot tell how far to advance
   * from the header alone. It slides forward a byte at a time instead, so a
   * PM-enabled guest against pre-PM defs loses only the unrecognized record,
   * not the rest of the session. These two cases pin both halves of that
   * contract.
   */
  it('decodes a PM record and keeps its place in the stream', () => {
    const bytes = Uint8Array.from([
      ...record(1000, 0x180, [...encU32(130)]), // pm_system_suspend_enter
      // pm_system_suspend_exit: ticks, then a one-byte state. An odd 5-byte
      // body, so a reader that mis-sized it would land mid-header next.
      ...record(2000, 0x181, [...encU32(130), 0]),
      ...record(3000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    const reader = new TraceReader(fallbackDefs())
    expect(reader.feed(bytes)).toBe(3)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events[0]?.name).toBe('pm_system_suspend_enter')
    expect(reader.tr.events[1]?.name).toBe('pm_system_suspend_exit')
    expect(reader.tr.events[1]?.fields).toEqual({ ticks: 130, state: 0 })
    // The record after the PM pair still lands, which is the real assertion.
    expect(reader.tr.events[2]?.name).toBe('thread_switched_in')
    expect(reader.tr.events[2]?.fields.name).toBe('main')
  })

  it('an unknown id resyncs on the next record instead of freezing the stream', () => {
    const bytes = Uint8Array.from([
      ...record(1000, 0x180, [...encU32(130)]),
      ...record(2000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(3000, 0x10, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(4000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    // A table that predates the guest's PM events, which is what a stale copy is.
    const stale = fallbackDefs()
    stale.delete(0x180)
    const reader = new TraceReader(stale)
    // The PM record itself is unrecoverable (no size to skip it by), but the
    // reader slides forward byte by byte and lands back on the real header of
    // the thread switch that follows it — those events still decode. Nothing
    // has been decoded yet at that point, so there is no earlier timestamp to
    // anchor the boundary; it takes a few agreeing headers to prove instead.
    expect(reader.feed(bytes)).toBe(3)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events).toHaveLength(3)
    expect(reader.tr.events[0]?.name).toBe('thread_switched_in')
    expect(reader.tr.t0).toBe(2000)
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

/*
 * public/tracing/metadata is a verbatim copy of Zephyr's
 * subsys/tracing/ctf/tsdl/metadata, and it is the table the page falls back to
 * for any guest that ships none of its own. When Zephyr renumbers its events and
 * this copy is not refreshed, the reader desyncs on the first moved record, so
 * "did someone forget to re-copy it" is worth failing a build over rather than
 * discovering live. FALLBACK_EVENTS matters for the same reason: it is what
 * decodes the stream when no table can be fetched at all.
 */
describe('the shipped metadata asset', () => {
  const defs = parseMetadata(
    readFileSync(resolve(process.cwd(), 'public/tracing/metadata'), 'utf8'),
  )

  it('declares every id FALLBACK_EVENTS knows, as the same event at the same size', () => {
    // Size is what the decoder advances by, so a size disagreement is the
    // desync. The name is checked too, because an id refreshed by offset rather
    // than by name can land on a different event of the very same size, and
    // every name-keyed reconstruction would then read the wrong one.
    expect(defs.size).toBeGreaterThan(300)
    for (const [key, { name, fields }] of Object.entries(types.FALLBACK_EVENTS)) {
      const eid = Number(key)
      const where = `id 0x${eid.toString(16)} (${name})`
      const def = defs.get(eid)
      expect(def, where).toBeDefined()
      expect(def?.name, where).toBe(name)
      expect(def?.size, where).toBe(makeEventDef(eid, name, fields).size)
    }
  })

  it('names every id constant in types.ts after the event the table puts there', () => {
    // Each constant is its event's name, upper-cased; two predate that habit.
    // This is the check a refresh by offset fails: the id it lands on names
    // the neighbouring event.
    const alias: Record<string, string> = {
      THREAD_PRIO_SET: 'thread_priority_set',
      THREAD_SCHED_PRIO_SET: 'thread_sched_priority_set',
    }
    const ids = Object.entries(types).filter(([, v]) => typeof v === 'number')
    expect(ids.length).toBeGreaterThan(30)
    for (const [constant, eid] of ids) {
      expect(defs.get(eid as number)?.name, constant).toBe(alias[constant] ?? constant.toLowerCase())
    }
  })

  it('declares the power-management events Zephyr main emits, at their sizes', () => {
    // Sizes are the packed body only, no header: CTF_EVENT memcpys fields
    // back-to-back with align = 8 throughout, so there is no padding.
    const expected: Array<[number, string, number]> = [
      [0x176, 'pm_device_runtime_get_enter', 4],
      [0x177, 'pm_device_runtime_get_exit', 8],
      [0x180, 'pm_system_suspend_enter', 4],
      [0x181, 'pm_system_suspend_exit', 5],
    ]
    for (const [eid, name, size] of expected) {
      const def = defs.get(eid)
      expect(def?.name, `id 0x${eid.toString(16)}`).toBe(name)
      expect(def?.size, `size of ${name}`).toBe(size)
    }
  })

  it('has none of the events the power band is built on', () => {
    // The page says so: docs/cpu-power-states.md and the Power tab's empty
    // state both tell the reader that Zephyr main cannot draw the band. If a
    // refresh brings these in, upstream has the hooks now, and both should say
    // so instead.
    const names = new Set([...defs.values()].map((d) => d.name))
    for (const name of [
      'pm_state_set_enter',
      'pm_state_set_exit',
      'pm_device_action_run_enter',
      'pm_device_action_run_exit',
    ]) {
      expect(names.has(name), name).toBe(false)
    }
  })
})
