import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFields, fallbackDefs, loadEventDefs, makeEventDef, parseMetadata } from './metadata'
import { TraceReader } from './reader'
import { FALLBACK_EVENTS } from './types'

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

/**
 * The built-in events plus the two the CPU power band needs and upstream Zephyr
 * does not trace, at the ids the guest the band was built against declares.
 */
function bandDefs() {
  const defs = fallbackDefs()
  defs.set(
    0x149,
    makeEventDef(0x149, 'pm_state_set_enter', [
      ['cpu', 'uint8_t'],
      ['state', 'uint8_t'],
      ['substate_id', 'uint8_t'],
    ]),
  )
  defs.set(
    0x156,
    makeEventDef(0x156, 'pm_device_action_run_exit', [
      ['dev', 'uint32_t'],
      ['action', 'uint8_t'],
      ['ret', 'int32_t'],
    ]),
  )
  return defs
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
      // pm_state_set_enter: cpu 0, state 3 (standby), substate 1 — a 3-byte
      // body, so a reader that mis-sized it would land mid-header next.
      ...record(1000, 0x149, [0, 3, 1]),
      ...record(2000, 0x156, [...encU32(0x4001_0a80), 0, ...encU32(0xffff_ffa8)]),
      ...record(3000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    const reader = new TraceReader(bandDefs())
    expect(reader.feed(bytes)).toBe(3)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events[0]?.name).toBe('pm_state_set_enter')
    expect(reader.tr.events[0]?.fields).toMatchObject({ cpu: 0, state: 3, substate_id: 1 })
    expect(reader.tr.events[1]?.name).toBe('pm_device_action_run_exit')
    // -ENOSYS, the honest answer for a device with no PM callbacks at all.
    expect(reader.tr.events[1]?.fields.ret).toBe(-88)
    // The record after the PM pair still lands, which is the real assertion.
    expect(reader.tr.events[2]?.name).toBe('thread_switched_in')
    expect(reader.tr.events[2]?.fields.name).toBe('main')
  })

  it('an unknown id resyncs on the next record instead of freezing the stream', () => {
    const bytes = Uint8Array.from([
      ...record(1000, 0x149, [0, 3, 1]),
      ...record(2000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(3000, 0x10, [...encU32(0x1000), ...encStr('main', 20)]),
      ...record(4000, 0x11, [...encU32(0x1000), ...encStr('main', 20)]),
    ])
    // The built-in events do not declare 0x149, like defs older than the guest.
    const reader = new TraceReader(fallbackDefs())
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
 * subsys/tracing/ctf/tsdl/metadata, the fallback for image releases that do not
 * ship their own (tools/build-zephyr-image.sh). When it is older than the guest,
 * the reader meets ids it cannot size, slides through them a byte at a time, and
 * now and then resyncs on a false boundary whose bogus timestamp then shifts
 * every later event. The images emit such events for every printed character
 * and every sleep, so "did someone copy an old file" is worth failing a build
 * over. FALLBACK_EVENTS matters for the same reason: it is what decodes the
 * stream when no metadata loads.
 */
describe('the shipped metadata asset', () => {
  const defs = parseMetadata(
    readFileSync(resolve(process.cwd(), 'public/tracing/metadata'), 'utf8'),
  )

  it('declares every id FALLBACK_EVENTS knows, at the same record size', () => {
    // Size, not name: record length is what the decoder advances by, so a size
    // disagreement is the desync, whereas a name difference is survivable —
    // reader.ts matches names as sets on purpose (SLEEP_ENTERS accepts both
    // `k_sleep_enter`, which is what the TSDL calls 0x7F, and the older
    // `thread_sleep_enter` this table still uses).
    expect(defs.size).toBeGreaterThan(300)
    for (const [key, { name, fields }] of Object.entries(FALLBACK_EVENTS)) {
      const eid = Number(key)
      const where = `id 0x${eid.toString(16)} (${name})`
      const def = defs.get(eid)
      expect(def, where).toBeDefined()
      expect(def?.size, where).toBe(makeEventDef(eid, name, fields).size)
    }
  })

  it('declares the events the current images emit between scheduler events', () => {
    // Sizes are the packed body only, no header: CTF_EVENT memcpys fields
    // back-to-back with align = 8 throughout, so there is no padding.
    const expected: Array<[number, string, number]> = [
      [0x180, 'pm_system_suspend_enter', 4],
      [0x181, 'pm_system_suspend_exit', 5],
      [0x182, 'syscall_enter', 24],
      [0x183, 'syscall_exit', 4],
      [0x184, 'thread_sleep_ticks_enter', 4],
      [0x185, 'thread_sleep_ticks_exit', 8],
    ]
    for (const [eid, name, size] of expected) {
      const def = defs.get(eid)
      expect(def?.name, `id 0x${eid.toString(16)}`).toBe(name)
      expect(def?.size, `size of ${name}`).toBe(size)
    }
  })

  it('decodes a printed character and a sleep without losing its place', () => {
    // What tracing_pipeline's storage thread writes around one console
    // character and a k_msleep(), numbered as its v4.5.0-rc1 image numbers them.
    const storage = 0x4001_c000
    const bytes = Uint8Array.from([
      ...record(5_980_000_000, 0x11, [...encU32(storage), ...encStr('storage', 20)]),
      ...record(5_980_100_000, 0x182, [...encU32(0x82), ...encStr('uart_poll_out', 20)]),
      ...record(5_980_200_000, 0x183, [...encU32(0x82)]),
      ...record(5_989_000_000, 0x184, [...encU32(10_000)]),
      ...record(5_989_100_000, 0x10, [...encU32(storage), ...encStr('storage', 20)]),
      ...record(6_000_000_000, 0x185, [...encU32(10_000), ...encU32(0)]),
      ...record(6_000_100_000, 0x11, [...encU32(storage), ...encStr('storage', 20)]),
    ])
    const reader = new TraceReader(defs)
    expect(reader.feed(bytes)).toBe(7)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events.map((e) => e.name)).toEqual([
      'thread_switched_in',
      'syscall_enter',
      'syscall_exit',
      'thread_sleep_ticks_enter',
      'thread_switched_out',
      'thread_sleep_ticks_exit',
      'thread_switched_in',
    ])
    expect(reader.tr.events[1]?.fields.name).toBe('uart_poll_out')
    expect(reader.tr.t1).toBe(6_000_100_000)
  })
})

describe('loadEventDefs', () => {
  const tsdl = `
event {
	name = thread_switched_in;
	id = 0x11;
	fields := struct {
		uint32_t thread_id;
		ctf_bounded_string_t name[20];
	};
};
`
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Answers fetch() from a table; anything not in it is a 404. */
  function serve(answers: Record<string, () => Response>) {
    const fetch = vi.fn(async (url: string) => {
      const answer = answers[url]
      return answer ? answer() : new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('reads the first URL that serves TSDL', async () => {
    const fetch = serve({ '/b': () => new Response(tsdl) })
    const defs = await loadEventDefs(['/a', '/b'])
    expect(defs.get(0x11)?.name).toBe('thread_switched_in')
    expect(defs.size).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops at the first one', async () => {
    const fetch = serve({ '/a': () => new Response(tsdl), '/b': () => new Response(tsdl) })
    await loadEventDefs(['/a', '/b'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes over a page served in place of a missing file', async () => {
    // A dev server's SPA fallback answers 200 with the app's index.html.
    serve({
      '/a': () => new Response('<!doctype html><html><body></body></html>'),
      '/b': () => new Response(tsdl),
    })
    expect((await loadEventDefs(['/a', '/b'])).size).toBe(1)
  })

  it('falls back to the built-in events when none serves any', async () => {
    serve({
      '/a': () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const defs = await loadEventDefs(['/a', '/b'])
    expect([...defs.keys()]).toEqual([...fallbackDefs().keys()])
  })
})
