import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fallbackDefs, makeEventDef, parseMetadata } from './metadata'
import {
  TraceReader,
  laneOrder,
  threadLabel,
  threadPrio,
  renderStateRows,
  fmtTime,
  fmtAxisTime,
  niceTimeStep,
  timeTickValues,
  threadRunningAt,
  stateAt,
  describeState,
  windowStats,
  contextSwitchesIn,
} from './reader'

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
function encI8(n: number): number[] {
  return [n & 0xff]
}
function encName(s: string): number[] {
  const out = Array.from({ length: 20 }, () => 0)
  for (let i = 0; i < Math.min(20, s.length); i++) out[i] = s.charCodeAt(i)
  return out
}

/** Build one CTF record: timestamp + id + body. */
function record(ts: number, eid: number, body: number[]): Uint8Array {
  return Uint8Array.from([...encU64(ts), ...encU16(eid), ...body])
}

describe('TraceReader', () => {
  it('decodes a ping-pong of thread switches into run/ready segments', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    const bytes = [
      ...record(1000, 0x13, [...encU32(a), ...encName('thread_a')]),
      ...record(1100, 0x13, [...encU32(b), ...encName('thread_b')]),
      ...record(2000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(3000, 0x10, [...encU32(a), ...encName('thread_a')]),
      ...record(3000, 0x11, [...encU32(b), ...encName('thread_b')]),
      ...record(5000, 0x10, [...encU32(b), ...encName('thread_b')]),
      ...record(5000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(7000, 0x10, [...encU32(a), ...encName('thread_a')]),
    ]
    expect(reader.feed(Uint8Array.from(bytes))).toBe(8)
    expect(reader.tr.threads.size).toBe(2)
    expect(threadLabel(reader.tr, a)).toBe('thread_a')
    expect(threadLabel(reader.tr, b)).toBe('thread_b')
    expect(reader.tr.segments).toEqual([
      [2000, 3000, a],
      [3000, 5000, b],
      [5000, 7000, a],
    ])
    // No prio yet — stable tid order (a < b), not busy time.
    const order = laneOrder(reader.tr)
    expect(order).toEqual([a, b])
    const rows = renderStateRows(reader.tr, order, reader.tr.t0, reader.tr.t1, 10)
    expect(rows.get(a)?.some((c) => c === 'run')).toBe(true)
    expect(rows.get(b)?.some((c) => c === 'run')).toBe(true)
  })

  it('orders Gantt lanes by Zephyr priority (lower = higher), unknown last', () => {
    const reader = new TraceReader(fallbackDefs())
    const coop = 0x1000
    const preempt = 0x2000
    const unknown = 0x3000
    const bytes = [
      ...record(100, 0x13, [...encU32(preempt), ...encName('preempt')]),
      ...record(110, 0x13, [...encU32(coop), ...encName('coop')]),
      ...record(120, 0x13, [...encU32(unknown), ...encName('unknown')]),
      // thread_priority_set: prio 7 then -2 (busy spans must not affect order).
      ...record(200, 0x12, [...encU32(preempt), ...encName('preempt'), ...encI8(7)]),
      ...record(210, 0x12, [...encU32(coop), ...encName('coop'), ...encI8(-2)]),
      ...record(1000, 0x11, [...encU32(preempt), ...encName('preempt')]),
      ...record(5000, 0x10, [...encU32(preempt), ...encName('preempt')]),
      ...record(5000, 0x11, [...encU32(coop), ...encName('coop')]),
      ...record(5500, 0x10, [...encU32(coop), ...encName('coop')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(threadPrio(reader.tr, coop)).toBe(-2)
    expect(threadPrio(reader.tr, preempt)).toBe(7)
    expect(threadPrio(reader.tr, unknown)).toBeNull()
    expect(laneOrder(reader.tr)).toEqual([coop, preempt, unknown])
  })

  it('keeps equal-prio lane order stable regardless of busy time', () => {
    const reader = new TraceReader(fallbackDefs())
    const lowBusy = 0x1000
    const highBusy = 0x2000
    const bytes = [
      ...record(100, 0x13, [...encU32(highBusy), ...encName('busy')]),
      ...record(110, 0x13, [...encU32(lowBusy), ...encName('quiet')]),
      ...record(200, 0x12, [...encU32(highBusy), ...encName('busy'), ...encI8(5)]),
      ...record(210, 0x12, [...encU32(lowBusy), ...encName('quiet'), ...encI8(5)]),
      // highBusy runs much longer — must not leapfrog lowBusy.
      ...record(1000, 0x11, [...encU32(highBusy), ...encName('busy')]),
      ...record(9000, 0x10, [...encU32(highBusy), ...encName('busy')]),
      ...record(9000, 0x11, [...encU32(lowBusy), ...encName('quiet')]),
      ...record(9100, 0x10, [...encU32(lowBusy), ...encName('quiet')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(laneOrder(reader.tr)).toEqual([lowBusy, highBusy])
  })

  it('holds a partial trailing record until the rest arrives', () => {
    const reader = new TraceReader(fallbackDefs())
    const full = record(100, 0x1b, [])
    const first = full.subarray(0, 6)
    const rest = full.subarray(6)
    expect(reader.feed(first)).toBe(0)
    expect(reader.tr.events).toHaveLength(0)
    expect(reader.feed(rest)).toBe(1)
    expect(reader.tr.events[0]?.name).toBe('isr_enter')
  })

  it('does not report the interrupted thread as running inside a closed or live ISR', () => {
    const reader = new TraceReader(fallbackDefs())
    const thread = 0x1000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(thread), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(thread), ...encName('worker')]),
        ...record(200, 0x1b, []),
      ]),
    )

    // The outer ISR is still open at the live edge.
    expect(threadRunningAt(reader.tr, 250)).toBeNull()

    reader.feed(record(300, 0x1c, []))
    expect(threadRunningAt(reader.tr, 199)).toBe(thread)
    expect(threadRunningAt(reader.tr, 200)).toBeNull()
    expect(threadRunningAt(reader.tr, 299)).toBeNull()
    expect(threadRunningAt(reader.tr, 300)).toBe(thread)
  })

  it('closes an ISR span at the next context switch when its exit was dropped', () => {
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const worker = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(worker), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        ...record(200, 0x1b, []),
        // ISR exit and switched_out were dropped; switched_in proves it ended.
        ...record(300, 0x11, [...encU32(worker), ...encName('worker')]),
      ]),
    )

    expect(reader.tr.isrOpenStart).toBeNull()
    expect(reader.tr.isrSpans).toContainEqual([200, 300])
    expect(threadRunningAt(reader.tr, 250)).toBeNull()
    expect(threadRunningAt(reader.tr, 300)).toBe(worker)
  })

  it('flags desync on an unknown event id without consuming past it', () => {
    const reader = new TraceReader(fallbackDefs())
    const bad = record(1, 0xdead, [1, 2, 3, 4])
    expect(reader.feed(bad)).toBe(0)
    expect(reader.desync).toBe(true)
  })

  it('resyncs on a live source that attaches mid-record instead of wedging forever', () => {
    // A desktop-bridge client joins an already-running CTF stream at an
    // arbitrary byte, not a record boundary — the first header it sees is
    // garbage. It must still recover once real records line up again, and
    // must not stay permanently stuck the way a one-shot file source would.
    //
    // With no earlier timestamp to anchor against, a boundary has to be proven
    // by several headers agreeing; a known id on its own used to be enough,
    // and that is what read payload bytes as a 64-bit timestamp. See
    // reader.live.test.ts.
    const reader = new TraceReader(fallbackDefs(), true, true)
    const thread = 0x1000
    const good = [
      ...record(1000, 0x13, [...encU32(thread), ...encName('worker')]),
      ...record(2000, 0x11, [...encU32(thread), ...encName('worker')]),
      ...record(3000, 0x10, [...encU32(thread), ...encName('worker')]),
    ]
    const misaligned = Uint8Array.from([1, 2, 3, ...good])
    expect(reader.feed(misaligned)).toBe(3)
    expect(reader.desync).toBe(false)
    expect(reader.tr.events.map((e) => e.name)).toEqual([
      'thread_create',
      'thread_switched_in',
      'thread_switched_out',
    ])
    expect(reader.tr.t0).toBe(1000)
  })

  it('makeEventDef sizes a str20 + uint32 body at 24 bytes', () => {
    const def = makeEventDef(0x11, 'thread_switched_in', [
      ['thread_id', 'uint32_t'],
      ['name', 'str20'],
    ])
    expect(def.size).toBe(24)
  })
})

describe('time-axis helpers', () => {
  it('fmtTime picks ns / µs / ms / s like the Python viewer', () => {
    expect(fmtTime(500)).toBe('500ns')
    expect(fmtTime(1_500)).toBe('1.500µs')
    expect(fmtTime(2_500_000)).toBe('2.500ms')
    expect(fmtTime(1_250_000_000)).toBe('1.250s')
  })

  it('niceTimeStep lands on a 1/2/5×10^n ladder', () => {
    expect(niceTimeStep(1_000_000_000, 5)).toBe(200_000_000)
    expect(niceTimeStep(5_000_000, 5)).toBe(1_000_000)
  })

  it('fmtAxisTime picks a unit from the tick step', () => {
    expect(fmtAxisTime(12_400_000, 200_000)).toBe('12.400ms')
    expect(fmtAxisTime(1_500, 500)).toBe('1.500µs')
    expect(fmtAxisTime(2_500_000_000, 1_000_000_000)).toBe('2.500s')
    // Past 1s → seconds even when the step is still in the ms ladder.
    expect(fmtAxisTime(5_776_375_000, 100_000)).toBe('5.7764s')
  })

  it('timeTickValues walks the nice step across the window', () => {
    const { values, step } = timeTickValues(0, 1_000_000_000, 5)
    expect(step).toBe(200_000_000)
    expect(values[0]).toBe(0)
    expect(values.at(-1)).toBe(1_000_000_000)
    expect(values).toHaveLength(6)
  })

  it('windowStats and threadRunningAt match the visible window', () => {
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    const b = 0x2000
    const bytes = [
      ...record(0, 0x13, [...encU32(a), ...encName('thread_a')]),
      ...record(0, 0x13, [...encU32(b), ...encName('thread_b')]),
      ...record(1_000, 0x11, [...encU32(a), ...encName('thread_a')]),
      ...record(5_000, 0x10, [...encU32(a), ...encName('thread_a')]),
      ...record(5_000, 0x11, [...encU32(b), ...encName('thread_b')]),
      ...record(9_000, 0x10, [...encU32(b), ...encName('thread_b')]),
    ]
    reader.feed(Uint8Array.from(bytes))
    expect(threadRunningAt(reader.tr, 3_000)).toBe(a)
    expect(threadRunningAt(reader.tr, 7_000)).toBe(b)
    const { per, spanNs } = windowStats(reader.tr, 0, 10_000)
    expect(spanNs).toBe(10_000)
    expect(per.get(a)?.run).toBe(4_000)
    expect(per.get(b)?.run).toBe(4_000)
    expect(contextSwitchesIn(reader.tr, 0, 10_000)).toBe(2)
    // Window that starts mid-trace must still skip the early SWITCHED_IN at t=1k.
    expect(contextSwitchesIn(reader.tr, 4_000, 10_000)).toBe(1)
    expect(contextSwitchesIn(reader.tr, 6_000, 10_000)).toBe(0)
  })

  it('sync CTF: threadRunningAt follows switched_out then switched_in', () => {
    // msg_queue / SYNC semihost: Zephyr emits a clean out→in pair.
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const worker = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(worker), ...encName('worker')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        ...record(200, 0x10, [...encU32(main), ...encName('main')]),
        ...record(200, 0x11, [...encU32(worker), ...encName('worker')]),
        ...record(300, 0x10, [...encU32(worker), ...encName('worker')]),
      ]),
    )
    expect(threadRunningAt(reader.tr, 150)).toBe(main)
    expect(threadRunningAt(reader.tr, 250)).toBe(worker)
    expect(threadRunningAt(reader.tr, 350)).toBeNull()
    // Only one runner at the switch instant — out closes main before in.
    expect(stateAt(reader.tr, main, 200)[0]).not.toBe('run')
  })

  it('async CTF: threadRunningAt recovers when switched_out is missing', () => {
    // http_server / ASYNC: ring drops can skip switched_out; demote on in.
    const reader = new TraceReader(fallbackDefs())
    const main = 0x1000
    const rx = 0x2000
    reader.feed(
      Uint8Array.from([
        ...record(0, 0x13, [...encU32(main), ...encName('main')]),
        ...record(10, 0x13, [...encU32(rx), ...encName('rx_q')]),
        ...record(100, 0x11, [...encU32(main), ...encName('main')]),
        // Missing switched_out for main — only switched_in for rx.
        ...record(200, 0x11, [...encU32(rx), ...encName('rx_q')]),
      ]),
    )
    expect(threadRunningAt(reader.tr, 250)).toBe(rx)
    expect(threadRunningAt(reader.tr, 150)).toBe(main)
    // Demote must clear main so Map-order scan cannot pin edges on it.
    expect(stateAt(reader.tr, main, 250)[0]).not.toBe('run')
  })
})

describe('events whose ids moved', () => {
  const shipped = () =>
    parseMetadata(readFileSync(resolve(process.cwd(), 'public/tracing/metadata'), 'utf8'))

  /**
   * The pm_state_set hooks are not upstream, so a guest that has them declares
   * them in its own table, at ids of its tree's choosing.
   */
  const POWER_HOOKS = `
event {
	name = pm_state_set_enter;
	id = 0x186;
	fields := struct {
		uint8_t cpu;
		uint8_t state;
		uint8_t substate_id;
	};
};
event {
	name = pm_state_set_exit;
	id = 0x187;
	fields := struct {
		uint8_t cpu;
		uint8_t state;
		uint8_t substate_id;
	};
};
`

  it('puts a thread to sleep on thread_sleep_ticks_enter, the one sleep hook main emits', () => {
    // k_sleep(), k_msleep() and k_usleep() all reach k_sleep_ticks() now, so a
    // guest from Zephyr main never sends k_sleep_enter. Missing this one paints
    // every sleeping thread as ready.
    const reader = new TraceReader(fallbackDefs())
    const a = 0x1000
    reader.feed(
      Uint8Array.from([
        ...record(1000, 0x11, [...encU32(a), ...encName('philosopher 0')]),
        ...record(2000, 0x184, [...encU32(25)]),
        ...record(2100, 0x10, [...encU32(a), ...encName('philosopher 0')]),
        ...record(5000, 0x11, [...encU32(a), ...encName('philosopher 0')]),
      ]),
    )
    expect(reader.desync).toBe(false)
    expect(stateAt(reader.tr, a, 3000)).toEqual(['slp', 'sleep 25', null])
  })

  it('lights the power band from a guest table that puts the PM events anywhere', () => {
    const reader = new TraceReader(parseMetadata(POWER_HOOKS))
    reader.feed(Uint8Array.from([...record(1000, 0x186, [0, 3, 0]), ...record(2000, 0x187, [0, 3, 0])]))
    expect(reader.tr.cpuPower.segs.get(0)).toEqual([[1000, 2000, 3, 0]])
  })

  it('keeps no power data for a guest without the pm_state_set hooks', () => {
    // Zephyr main traces pm_system_suspend, but its exit reports ACTIVE for
    // every successful suspend, so on its own it would record each one as the
    // policy declining.
    const reader = new TraceReader(shipped())
    reader.feed(
      Uint8Array.from([...record(1000, 0x180, encU32(110)), ...record(2000, 0x181, [...encU32(110), 0])]),
    )
    expect(reader.tr.events.map((e) => e.name)).toEqual(['pm_system_suspend_enter', 'pm_system_suspend_exit'])
    expect(reader.tr.cpuPower.decisions).toEqual([])
  })

  it('does not take the heap events at the old PM ids for power management', () => {
    // 0x147 to 0x156 were the PM events before Zephyr renumbered; they are
    // k_heap and k_malloc now, and fire constantly on an LVGL guest. A guest
    // with the power hooks has both, and only the names tell them apart.
    const defs = shipped()
    for (const [eid, def] of parseMetadata(POWER_HOOKS)) defs.set(eid, def)
    const bytes: number[] = []
    let ts = 1000
    for (let eid = 0x147; eid <= 0x156; eid++) {
      const def = defs.get(eid)!
      expect(def.name).toMatch(/^heap_/)
      bytes.push(...record((ts += 100), eid, Array.from({ length: def.size }, () => 0)))
    }
    const reader = new TraceReader(defs)
    expect(reader.feed(Uint8Array.from(bytes))).toBe(0x156 - 0x147 + 1)
    expect(reader.tr.cpuPower.segs.size).toBe(0)
    expect(reader.tr.cpuPower.decisions).toEqual([])
    expect(reader.tr.cpuPower.dropped.activeEnter).toBe(0)
  })
})

describe('what a blocked thread waits on', () => {
  // Thread and object addresses from the sensor pipeline on the Cortex-A53.
  const AGG = 0x40021620
  const STORAGE = 0x40020000
  const C0 = 0x40021270
  const SENSOR = 0x4001f000
  const BUS = 0x40012268
  const FRAME_MUTEX = 0x400122a0
  const FRAME_COND = 0x40012330
  const SENSOR_Q = 0x400122d8
  const SEM = 0x40013000
  const FOREVER = 0xffffd8f0
  const NAMES = new Map([
    [BUS, 'bus_mutex'],
    [FRAME_MUTEX, 'frame_mutex'],
    [FRAME_COND, 'frame_cond'],
  ])
  const nameOf = (_kind: string, address: number) => NAMES.get(address)

  type Ev = [ts: number, name: string, fields?: Record<string, number>]

  const table = () =>
    parseMetadata(readFileSync(resolve(process.cwd(), 'public/tracing/metadata'), 'utf8'))

  /** Lay `events` out as Zephyr's table says and read them. */
  function replay(events: Ev[]) {
    const defs = table()
    const byName = new Map([...defs.values()].map((def) => [def.name, def]))
    const bytes = events.flatMap(([ts, name, fields = {}]) => {
      const def = byName.get(name)
      if (!def) throw new Error(`${name} is not in the table`)
      const body = def.fields.flatMap(({ name: field, kind }) => {
        const value = fields[field] ?? 0
        if (typeof kind === 'object') return Array.from({ length: kind.str }, () => 0)
        if (kind === 'int8_t' || kind === 'uint8_t') return [value & 0xff]
        if (kind === 'uint16_t') return encU16(value)
        if (kind === 'uint64_t') return encU64(value)
        return encU32(value)
      })
      return [...encU64(ts), ...encU16(def.eid), ...body]
    })
    const reader = new TraceReader(defs)
    expect(reader.feed(Uint8Array.from(bytes))).toBe(events.length)
    return reader.tr
  }

  const switchTo = (ts: number, from: number, to: number): Ev[] => [
    [ts, 'thread_switched_out', { thread_id: from }],
    [ts, 'thread_switched_in', { thread_id: to }],
  ]

  /** consumer0 gives up frame_mutex to wait on frame_cond, and the aggregator runs. */
  const consumerWaits: Ev[] = [
    [200, 'thread_switched_in', { thread_id: C0 }],
    [210, 'mutex_lock_enter', { id: FRAME_MUTEX, timeout: FOREVER }],
    [211, 'mutex_lock_exit', { id: FRAME_MUTEX, timeout: FOREVER, ret: 0 }],
    [220, 'condvar_wait_enter', { id: FRAME_COND, timeout: FOREVER }],
    [221, 'mutex_unlock_enter', { id: FRAME_MUTEX }],
    [222, 'mutex_unlock_exit', { id: FRAME_MUTEX, ret: 0 }],
    [223, 'thread_sched_pend', { thread_id: C0 }],
    ...switchTo(224, C0, AGG),
  ]

  it('names the mutex the aggregator waits on, across the priority it lends', () => {
    const tr = replay([
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      [110, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
      [111, 'mutex_lock_exit', { id: BUS, timeout: FOREVER, ret: 0 }],
      ...switchTo(120, STORAGE, AGG),
      [130, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      [132, 'thread_sched_priority_set', { thread_id: STORAGE, prio: 3 }],
      [133, 'thread_sched_pend', { thread_id: AGG }],
      ...switchTo(134, AGG, STORAGE),
    ])
    const [state, reason, object] = stateAt(tr, AGG, 140)
    expect([state, reason, object]).toEqual(['blk', 'mutex', BUS])
    expect(describeState(state!, reason, object, nameOf)).toBe('blocked on mutex bus_mutex')
  })

  it('names the condvar a waiter pends on, then the mutex it takes back', () => {
    const tr = replay([
      ...consumerWaits,
      // The aggregator publishes, and the consumer, woken first, finds the
      // mutex still taken.
      [300, 'mutex_lock_enter', { id: FRAME_MUTEX, timeout: FOREVER }],
      [301, 'mutex_lock_exit', { id: FRAME_MUTEX, timeout: FOREVER, ret: 0 }],
      [302, 'condvar_broadcast_enter', { id: FRAME_COND }],
      [303, 'thread_sched_ready', { thread_id: C0 }],
      [304, 'condvar_broadcast_exit', { id: FRAME_COND, ret: 1 }],
      ...switchTo(305, AGG, C0),
      [310, 'mutex_lock_enter', { id: FRAME_MUTEX, timeout: FOREVER }],
      [311, 'mutex_lock_blocking', { id: FRAME_MUTEX, timeout: FOREVER }],
      [312, 'thread_sched_pend', { thread_id: C0 }],
      ...switchTo(313, C0, AGG),
    ])
    expect(stateAt(tr, C0, 250)).toEqual(['blk', 'condvar', FRAME_COND])
    expect(describeState('blk', 'condvar', FRAME_COND, nameOf)).toBe('blocked on condvar frame_cond')
    expect(stateAt(tr, C0, 320)).toEqual(['blk', 'mutex', FRAME_MUTEX])
  })

  it('leaves a thread that signals a condvar ready while the woken waiter runs', () => {
    // k_condvar_signal() logs condvar_signal_blocking in the signaller, just
    // before it reschedules.
    const tr = replay([
      ...consumerWaits,
      [300, 'condvar_signal_enter', { id: FRAME_COND }],
      [301, 'thread_sched_ready', { thread_id: C0 }],
      [302, 'condvar_signal_blocking', { id: FRAME_COND, timeout: FOREVER }],
      ...switchTo(303, AGG, C0),
    ])
    expect(stateAt(tr, AGG, 310)[0]).toBe('rdy')
  })

  it('does not carry a signal over to the next thing the signaller waits on', () => {
    const tr = replay([
      ...consumerWaits,
      [300, 'condvar_signal_enter', { id: FRAME_COND }],
      [301, 'thread_sched_ready', { thread_id: C0 }],
      [302, 'condvar_signal_blocking', { id: FRAME_COND, timeout: FOREVER }],
      [303, 'condvar_signal_exit', { id: FRAME_COND, ret: 0 }],
      // A k_poll() wait logs no *_blocking of its own.
      [310, 'poll_enter', { events_id: 0x40030000 }],
      [311, 'thread_sched_pend', { thread_id: AGG }],
      ...switchTo(312, AGG, C0),
    ])
    expect(stateAt(tr, AGG, 320)).toEqual(['blk', '', null])
    expect(describeState('blk', '', null, nameOf)).toBe('blocked')
  })

  it('leaves a getter that makes room for a waiting writer ready', () => {
    // k_msgq_get() logs msgq_get_blocking when it frees a slot for a writer
    // waiting on a full queue, and goes on.
    const tr = replay([
      [100, 'thread_switched_in', { thread_id: SENSOR }],
      [110, 'msgq_put_enter', { id: SENSOR_Q, timeout: FOREVER }],
      [111, 'msgq_put_blocking', { id: SENSOR_Q, timeout: FOREVER }],
      [112, 'thread_sched_pend', { thread_id: SENSOR }],
      ...switchTo(113, SENSOR, AGG),
      [120, 'msgq_get_enter', { id: SENSOR_Q, timeout: FOREVER }],
      [121, 'msgq_get_blocking', { id: SENSOR_Q, timeout: FOREVER }],
      [122, 'thread_sched_ready', { thread_id: SENSOR }],
      [123, 'msgq_get_exit', { id: SENSOR_Q, timeout: FOREVER, ret: 0 }],
      ...switchTo(124, AGG, SENSOR),
    ])
    expect(stateAt(tr, SENSOR, 115)).toEqual(['blk', 'msgq', SENSOR_Q])
    expect(stateAt(tr, AGG, 130)[0]).toBe('rdy')
  })

  it('names the thread a join waits for, which it logs after pending', () => {
    const tr = replay([
      [100, 'thread_switched_in', { thread_id: AGG }],
      [110, 'thread_join_enter', { thread_id: STORAGE, timeout: FOREVER }],
      [111, 'thread_sched_pend', { thread_id: AGG }],
      [112, 'thread_join_blocking', { thread_id: STORAGE, timeout: FOREVER }],
      ...switchTo(113, AGG, STORAGE),
    ])
    expect(stateAt(tr, AGG, 120)).toEqual(['blk', 'join', STORAGE])
  })

  it('blocks a thread that logged *_blocking and switched out, on a guest that logs no pend', () => {
    // Zephyr before 4.3, read with today's table: its sync ids have not moved.
    const tr = replay([
      [100, 'thread_switched_in', { thread_id: AGG }],
      [110, 'semaphore_take_enter', { id: SEM, timeout: FOREVER }],
      [111, 'semaphore_take_blocking', { id: SEM, timeout: FOREVER }],
      ...switchTo(112, AGG, STORAGE),
    ])
    expect(stateAt(tr, AGG, 120)).toEqual(['blk', 'sem', SEM])
    expect(describeState('blk', 'sem', SEM, nameOf)).toBe('blocked on sem 0x40013000')
  })
})
