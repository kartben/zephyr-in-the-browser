/**
 * Which event table a trace is decoded with. CTF ids are positional and Zephyr
 * renumbers them, so a guest's trace goes through the table its image shipped
 * with, and everything else through the page's own copy.
 */

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { depthAt, fallbackDefs, reconstructQueues, TraceReader } from '@/ctf'
import * as hostTrace from '@/hostTrace'
import { MSGQ, queueBacklog } from '@/testing/ctfSynth'

const BUNDLED = readFileSync('public/tracing/metadata', 'utf8')

/**
 * The PM pair the power band is built on, where a Zephyr tree carrying the
 * hooks put it. The page's own table has k_heap events at those two ids.
 */
const GUEST_TABLE = `
event {
	name = pm_state_set_enter;
	id = 0x149;
	fields := struct {
		uint8_t cpu;
		uint8_t state;
		uint8_t substate_id;
	};
};
event {
	name = pm_state_set_exit;
	id = 0x14A;
	fields := struct {
		uint8_t cpu;
		uint8_t state;
		uint8_t substate_id;
	};
};
`

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
function record(ts: number, eid: number, body: number[]): number[] {
  return [...encU64(ts), ...encU16(eid), ...body]
}

/** An Emscripten module whose filesystem holds `tracing.bin`, or nothing. */
function guest(trace: Uint8Array | null) {
  return {
    FS: {
      analyzePath: (path: string) =>
        trace && path === './tracing.bin'
          ? { exists: true, object: { contents: trace, usedBytes: trace.length } }
          : { exists: false },
    },
  }
}

const fetchMock = vi.fn(async (url: string) => {
  if (url.endsWith('/tracing/metadata')) return new Response(BUNDLED)
  if (url.endsWith('/with-table.tsdl')) return new Response(GUEST_TABLE)
  return new Response('', { status: 404 })
})

const eventNames = () => hostTrace.getSnapshot().trace?.events.map((e) => e.name) ?? []

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  hostTrace.endExternal()
  hostTrace.detach()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the table a guest trace is decoded with', () => {
  it('is the one shipped beside the image', async () => {
    // Read with the page's table, these two records would be k_heap events of
    // another size, and the second would not even be found.
    const bytes = Uint8Array.from([...record(1000, 0x149, [0, 3, 0]), ...record(2000, 0x14a, [0, 3, 0])])
    hostTrace.attach(guest(bytes), '/qemu/zephyr/a53/with-table.tsdl')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventNames()).toEqual(['pm_state_set_enter', 'pm_state_set_exit'])
    expect(hostTrace.getSnapshot().desync).toBe(false)
    expect(hostTrace.getSnapshot().trace?.cpuPower.segs.get(0)).toEqual([[1000, 2000, 3, 0]])
    expect(fetchMock).toHaveBeenCalledWith('/qemu/zephyr/a53/with-table.tsdl')
  })

  it('is the page’s own when the image shipped none', async () => {
    // thread_sleep_ticks_enter is only in Zephyr main's table, so decoding it
    // proves which table was used.
    const bytes = Uint8Array.from(record(1000, 0x184, encU32(25)))
    hostTrace.attach(guest(bytes), '/qemu/zephyr/a53/older-release.tsdl')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventNames()).toEqual(['thread_sleep_ticks_enter'])
    expect(hostTrace.getSnapshot().desync).toBe(false)
  })

  it('is not fetched for a guest that never writes a trace', async () => {
    hostTrace.attach(guest(null), '/qemu/zephyr/a53/untraced.tsdl')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a live board', () => {
  it('decodes with the page’s table, not that of an image the tab ran before', async () => {
    hostTrace.attach(guest(Uint8Array.from(record(1000, 0x149, [0, 3, 0]))), '/qemu/zephyr/a53/with-table.tsdl')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(eventNames()).toEqual(['pm_state_set_enter'])

    hostTrace.beginExternal('bridge')
    await vi.advanceTimersByTimeAsync(1_000)
    // A live source can start mid-record, so the reader wants a few headers
    // that agree before it trusts a boundary.
    const sleeps = [5000, 6000, 7000, 8000].flatMap((ts) => record(ts, 0x184, encU32(25)))
    hostTrace.feedExternal(Uint8Array.from(sleeps))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(eventNames()).toEqual(Array.from({ length: 4 }, () => 'thread_sleep_ticks_enter'))
  })
})

describe('the live event log', () => {
  it('keeps queue depths right once its oldest events are dropped', () => {
    const bytes = queueBacklog(12_000)
    for (let off = 0; off < bytes.length; off += 65_536) hostTrace.debugFeed(bytes.subarray(off, off + 65_536))
    const live = hostTrace.getSnapshot().trace!
    const whole = new TraceReader(fallbackDefs())
    whole.feed(bytes)
    expect(live.events.length).toBeLessThan(whole.tr.events.length)

    const truth = reconstructQueues(whole.tr).find((q) => q.id === MSGQ)!.samples
    const shown = reconstructQueues(live).find((q) => q.id === MSGQ)!.samples
    expect(shown.length).toBeGreaterThan(1_000)
    for (const { ts, depth } of shown) expect(depthAt(truth, ts), `at ${ts}`).toBe(depth)
  })
})
