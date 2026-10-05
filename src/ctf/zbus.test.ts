import { describe, expect, it } from 'vitest'
import { fallbackDefs, makeEventDef } from './metadata'
import { TraceReader } from './reader'
import { hasZbusEvents, reconstructZbus, zbusErrno, zbusWindowStats } from './zbus'

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

/** The zbus events as the proposed Zephyr TSDL declares them (0x186..0x197). */
const ZBUS_DEFS: Array<[number, string, Array<[string, 'uint32_t' | 'int32_t']>]> = [
  [0x186, 'zbus_chan_pub_enter', [['id', 'uint32_t'], ['timeout', 'uint32_t']]],
  [0x187, 'zbus_chan_pub_exit', [['id', 'uint32_t'], ['timeout', 'uint32_t'], ['ret', 'int32_t']]],
  [0x188, 'zbus_chan_read_enter', [['id', 'uint32_t'], ['timeout', 'uint32_t']]],
  [0x189, 'zbus_chan_read_exit', [['id', 'uint32_t'], ['timeout', 'uint32_t'], ['ret', 'int32_t']]],
  [0x190, 'zbus_sub_wait_enter', [['id', 'uint32_t'], ['timeout', 'uint32_t']]],
  [
    0x191,
    'zbus_sub_wait_exit',
    [['id', 'uint32_t'], ['timeout', 'uint32_t'], ['chan', 'uint32_t'], ['ret', 'int32_t']],
  ],
  [0x194, 'zbus_obs_notify_enter', [['id', 'uint32_t'], ['chan', 'uint32_t']]],
  [0x195, 'zbus_obs_notify_exit', [['id', 'uint32_t'], ['chan', 'uint32_t'], ['ret', 'int32_t']]],
  [0x196, 'zbus_async_listener_enter', [['id', 'uint32_t'], ['chan', 'uint32_t']]],
  [0x197, 'zbus_async_listener_exit', [['id', 'uint32_t'], ['chan', 'uint32_t']]],
]

function defs() {
  const all = fallbackDefs()
  for (const [eid, name, fields] of ZBUS_DEFS) all.set(eid, makeEventDef(eid, name, fields))
  return all
}

const MAIN = 0x4001_a780
const SUB_THREAD = 0x4001_a000
const WORKQ = 0x4001_ab30
const ACC = 0x4000_e150
const SIMPLE = 0x4000_e180
const FOO_LIS = 0x4000_e220
const BAR_SUB = 0x4000_e1e0
const BAZ_LIS = 0x4000_e200
const BAZ_WORK = 0x4001_0010
const ENOMSG = -35

const run = (ts: number, tid: number, name: string) =>
  record(ts, 0x11, [...encU32(tid), ...encStr(name, 20)])
const out = (ts: number, tid: number, name: string) =>
  record(ts, 0x10, [...encU32(tid), ...encStr(name, 20)])

/**
 * One publish on acc_data_chan the way hello_world makes it, then a rejected
 * publish on simple_chan: the subscriber preempts main mid-publish and blocks
 * on the channel's lock, the async listener runs in the work queue, and the
 * subscriber reads once main unlocks.
 */
function helloWorld(): Uint8Array[] {
  return [
    run(100, SUB_THREAD, 'subscriber_task_id'),
    record(110, 0x190, [...encU32(BAR_SUB), ...encU32(0xffffffff)]),
    out(120, SUB_THREAD, 'subscriber_task_id'),
    run(130, MAIN, 'main'),
    record(1_000, 0x186, [...encU32(ACC), ...encU32(1_000_000)]),
    record(1_100, 0x194, [...encU32(FOO_LIS), ...encU32(ACC)]),
    record(1_600, 0x195, [...encU32(FOO_LIS), ...encU32(ACC), ...encU32(0)]),
    record(1_700, 0x194, [...encU32(BAR_SUB), ...encU32(ACC)]),
    out(1_750, MAIN, 'main'),
    run(1_760, SUB_THREAD, 'subscriber_task_id'),
    record(1_800, 0x191, [...encU32(BAR_SUB), ...encU32(0xffffffff), ...encU32(ACC), ...encU32(0)]),
    record(1_850, 0x188, [...encU32(ACC), ...encU32(500_000)]),
    out(1_900, SUB_THREAD, 'subscriber_task_id'),
    run(1_910, MAIN, 'main'),
    record(2_000, 0x195, [...encU32(BAR_SUB), ...encU32(ACC), ...encU32(0)]),
    record(2_100, 0x194, [...encU32(BAZ_LIS), ...encU32(ACC)]),
    out(2_150, MAIN, 'main'),
    run(2_160, WORKQ, 'sysworkq'),
    record(2_200, 0x196, [...encU32(BAZ_WORK), ...encU32(ACC)]),
    record(2_700, 0x197, [...encU32(BAZ_WORK), ...encU32(ACC)]),
    out(2_750, WORKQ, 'sysworkq'),
    run(2_760, MAIN, 'main'),
    record(2_800, 0x195, [...encU32(BAZ_LIS), ...encU32(ACC), ...encU32(0)]),
    out(2_850, MAIN, 'main'),
    run(2_860, SUB_THREAD, 'subscriber_task_id'),
    record(2_900, 0x189, [...encU32(ACC), ...encU32(500_000), ...encU32(0)]),
    out(2_950, SUB_THREAD, 'subscriber_task_id'),
    run(2_960, MAIN, 'main'),
    record(3_000, 0x187, [...encU32(ACC), ...encU32(1_000_000), ...encU32(0)]),
    record(4_000, 0x186, [...encU32(SIMPLE), ...encU32(200_000)]),
    record(4_050, 0x187, [...encU32(SIMPLE), ...encU32(200_000), ...encU32(ENOMSG >>> 0)]),
  ]
}

function trace(records: Uint8Array[]) {
  const r = new TraceReader(defs(), true, false)
  for (const rec of records) r.feed(rec)
  return r.tr
}

describe('reconstructZbus', () => {
  const tr = trace(helloWorld())
  const zbus = reconstructZbus(tr)

  it('pairs each call with its exit, in the thread that made it', () => {
    expect(zbus.calls.map((c) => [c.op, c.chan, c.thread, c.t0, c.t1, c.ret])).toEqual([
      ['pub', ACC, MAIN, 1_000, 3_000, 0],
      ['read', ACC, SUB_THREAD, 1_850, 2_900, 0],
      ['pub', SIMPLE, MAIN, 4_000, 4_050, ENOMSG],
    ])
  })

  it('puts each notification inside the publish that made it, in dispatch order', () => {
    const pub = zbus.calls[0]!
    expect(pub.notifies.map((n) => [n.obs, n.t0, n.t1, n.ret])).toEqual([
      [FOO_LIS, 1_100, 1_600, 0],
      [BAR_SUB, 1_700, 2_000, 0],
      [BAZ_LIS, 2_100, 2_800, 0],
    ])
  })

  it('records the subscriber waking with the channel that notified it', () => {
    expect(zbus.wakes).toEqual([
      { obs: BAR_SUB, chan: ACC, t: 1_800, since: 110, thread: SUB_THREAD, ret: 0, msg: false },
    ])
  })

  it('records the async listener running in the work queue', () => {
    expect(zbus.runs).toEqual([{ work: BAZ_WORK, chan: ACC, thread: WORKQ, t0: 2_200, t1: 2_700 }])
  })

  it('leaves a call open while the trace has not seen it return', () => {
    const open = reconstructZbus(trace(helloWorld().slice(0, 6)))
    expect(open.calls[0]).toMatchObject({ op: 'pub', t1: null, ret: null })
    expect(open.calls[0]!.notifies[0]).toMatchObject({ obs: FOO_LIS, t1: null })
  })

  it('knows a trace without zbus events', () => {
    expect(hasZbusEvents(tr)).toBe(true)
    expect(hasZbusEvents(trace([run(100, MAIN, 'main')]))).toBe(false)
  })

  it('counts what falls in a window', () => {
    expect(zbusWindowStats(zbus, 0, 5_000)).toEqual({
      publishes: 2,
      rejected: 1,
      notifications: 3,
      reads: 1,
    })
    expect(zbusWindowStats(zbus, 3_500, 5_000)).toMatchObject({ publishes: 1, notifications: 0 })
  })

  it('names the errnos a zbus call returns', () => {
    expect(zbusErrno(ENOMSG)).toBe('-ENOMSG')
    expect(zbusErrno(-11)).toBe('-EAGAIN')
    expect(zbusErrno(-999)).toBe('-999')
  })
})
