import { describe, expect, it } from 'vitest'
import type { Trace, ZbusActivity, ZbusAsyncRun, ZbusCall, ZbusWake } from '@/ctf'
import type { ZbusObserverInfo, ZbusTopology } from '@/debug/elfZbus'
import {
  LABEL_W,
  buildRows,
  placeRows,
  zbusHitTest,
  zbusTip,
  type Placed,
  type ZbusXScale,
} from './zbusChart'

// The zbus Hello World sample, with timings from a traced run on qemu_cortex_a53.
const ACC = 0x4001_2170
const SIMPLE = 0x4001_21a0
const FOO_LIS = 0x4001_2240
const BAR_SUB = 0x4001_2200
const BAZ = 0x4001_2220
const BAZ_WORK = 0x4001_4010
const MAIN = 1
const SUB = 2
const WORKQ = 3

const ms = (n: number) => Math.round(n * 1_000_000)

const obs = (addr: number, name: string, kind: ZbusObserverInfo['kind']): ZbusObserverInfo => ({
  addr,
  name,
  kind,
  target: null,
  targetName: null,
})
const fooLis = obs(FOO_LIS, 'foo_lis', 'listener')
const barSub = obs(BAR_SUB, 'bar_sub', 'subscriber')
const baz = obs(BAZ, 'baz_async_lis', 'async_listener')

const channels = [
  { addr: ACC, name: 'acc_data_chan', messageSize: 12, validator: null, observers: [fooLis, barSub, baz] },
  { addr: SIMPLE, name: 'simple_chan', messageSize: 4, validator: 'simple_chan_validator', observers: [] },
]
const topo: ZbusTopology = {
  channels,
  observers: [fooLis, barSub, baz],
  channelByAddr32: new Map(channels.map((c) => [c.addr, c])),
  observerByAddr32: new Map([fooLis, barSub, baz].map((o) => [o.addr, o])),
  observerByWork32: new Map([[BAZ_WORK, baz]]),
}

const tr = {
  t1: ms(2000),
  threads: new Map([
    [MAIN, { name: 'main' }],
    [SUB, { name: 'subscriber_task_id' }],
    [WORKQ, { name: 'sysworkq' }],
  ]),
} as unknown as Trace

const pub: ZbusCall = {
  op: 'pub',
  chan: ACC,
  thread: MAIN,
  t0: ms(0),
  t1: ms(28.555),
  ret: 0,
  timeoutUs: 1_000_000,
  notifies: [
    { obs: FOO_LIS, t0: ms(2.14), t1: ms(7.46), ret: 0 },
    { obs: BAR_SUB, t0: ms(7.615), t1: ms(10.385), ret: 0 },
    { obs: BAZ, t0: ms(10.45), t1: ms(20.415), ret: 0 },
  ],
}
const read: ZbusCall = {
  op: 'read',
  chan: ACC,
  thread: SUB,
  t0: ms(9.21),
  t1: ms(22.795),
  ret: 0,
  timeoutUs: 500_000,
  notifies: [],
}
const rejected: ZbusCall = {
  op: 'pub',
  chan: SIMPLE,
  thread: MAIN,
  t0: ms(1063.595),
  t1: ms(1063.645),
  ret: -35,
  timeoutUs: 200_000,
  notifies: [],
}
const wake: ZbusWake = { obs: BAR_SUB, chan: ACC, t: ms(8.865), since: null, thread: SUB, ret: 0, msg: false }
const run: ZbusAsyncRun = { work: BAZ_WORK, chan: ACC, thread: WORKQ, t0: ms(13.36), t1: ms(18.925) }
const activity: ZbusActivity = { calls: [pub, read, rejected], wakes: [wake], runs: [run] }

const rows = buildRows(topo, activity)
const items = placeRows(rows, activity, topo)
const rowOf = (label: string) => rows.findIndex((r) => r.label === label)
const itemsOf = (label: string) => items[rowOf(label)]!
const kinds = (placed: Placed[]) => placed.map((p) => p.item.kind)

/** 0 to 30 ms across 600 px: 20 px per ms. */
function scaleFor(t0: number, t1: number, plotW = 600): ZbusXScale {
  return {
    X: (t) => LABEL_W + ((t - t0) / (t1 - t0)) * plotW,
    plotLeft: LABEL_W,
    plotRight: LABEL_W + plotW,
    openEnd: t1,
  }
}
const BODY_TOP = 28
/** Row tops for the rows above: acc 28, foo 60, bar 82, baz 104, simple 126. */
const ROW_TOP = { acc: 28, foo: 60, bar: 82, baz: 104, simple: 126 }

describe('placeRows', () => {
  it('puts publishes at the top of a channel row and reads under them', () => {
    const acc = itemsOf('acc_data_chan')
    expect(kinds(acc)).toEqual(['call', 'call'])
    expect(acc.map((p) => [p.top, p.height])).toEqual([
      [5, 13],
      [23, 6],
    ])
  })

  it('shades a claimed channel from claim to finish', () => {
    const claim: ZbusCall = { ...read, op: 'claim', thread: MAIN, t0: ms(40), t1: ms(40.1) }
    const finish: ZbusCall = { ...read, op: 'finish', thread: MAIN, t0: ms(41.1), t1: ms(41.2), timeoutUs: null }
    const a: ZbusActivity = { calls: [claim, finish], wakes: [], runs: [] }
    const r = buildRows(topo, a)
    const held = placeRows(r, a, topo)[0]!.find((p) => p.item.kind === 'held')!
    expect([held.t0, held.t1]).toEqual([ms(40.1), ms(41.1)])
    expect(zbusTip(tr, topo, a.calls, r[0]!, held)).toEqual(['claimed by main', 'held 1.000ms'])
  })

  it('gives each observer its notification, a subscriber its wake and read, an async listener its run', () => {
    expect(kinds(itemsOf('foo_lis'))).toEqual(['notify'])
    const bar = itemsOf('bar_sub')
    expect(kinds(bar)).toEqual(['notify', 'wake', 'read'])
    // Dashed hand-offs: from the put to the wake, and from the wake to the read.
    expect(bar.map((p) => p.from)).toEqual([null, ms(7.615), ms(8.865)])
    const bz = itemsOf('baz_async_lis')
    expect(kinds(bz)).toEqual(['notify', 'run'])
    expect(bz[1]!.from).toBe(ms(10.45))
  })
})

describe('zbusHitTest', () => {
  const scale = scaleFor(0, ms(30))
  const hit = (x: number, y: number, s = scale) => zbusHitTest(rows, items, BODY_TOP, x, y, s)

  it('names the row over the gutter', () => {
    expect(hit(50, ROW_TOP.bar + 10)).toMatchObject({ row: rowOf('bar_sub'), placed: null })
  })

  it('tells a publish from the read drawn under it', () => {
    const x = scale.X(ms(15))
    expect(hit(x, ROW_TOP.acc + 10)?.placed?.item).toMatchObject({ kind: 'call', call: pub })
    expect(hit(x, ROW_TOP.acc + 26)?.placed?.item).toMatchObject({ kind: 'call', call: read })
  })

  it('prefers a dot to the bar it sits on, and a run to the hand-off under it', () => {
    expect(hit(scale.X(ms(8.865)), ROW_TOP.bar + 11)?.placed?.item.kind).toBe('wake')
    expect(hit(scale.X(ms(15)), ROW_TOP.baz + 11)?.placed?.item.kind).toBe('run')
  })

  it('reaches a sliver from a few pixels away, and nothing further', () => {
    const wide = scaleFor(ms(1000), ms(1100))
    const x = wide.X(ms(1063.595)) + 2
    expect(hit(x + 3, ROW_TOP.simple + 10, wide)?.placed?.item).toMatchObject({ call: rejected })
    expect(hit(x + 12, ROW_TOP.simple + 10, wide)).toBeNull()
  })

  it('finds nothing where nothing is drawn', () => {
    expect(hit(scale.X(ms(25)), ROW_TOP.foo + 11)).toBeNull()
    expect(hit(scale.X(ms(25)), 400)).toBeNull()
  })
})

describe('zbusTip', () => {
  const tip = (label: string, kind: Placed['item']['kind'] | null, a = activity) => {
    const i = rowOf(label)
    const placed = kind === null ? null : items[i]!.find((p) => p.item.kind === kind)!
    return zbusTip(tr, topo, a.calls, rows[i]!, placed)
  }

  it('says who published, how long it took and how many it told', () => {
    expect(tip('acc_data_chan', 'call')).toEqual(['publish · main', '28.555ms, told 3 observers'])
  })

  it('says why a publish failed', () => {
    expect(tip('simple_chan', 'call')).toEqual(['publish · main', '-ENOMSG: rejected by the validator'])
    const timedOut = { ...rejected, ret: -11 }
    const row = rows[rowOf('simple_chan')]!
    const placed: Placed = { ...items[rowOf('simple_chan')]![0]!, item: { kind: 'call', call: timedOut } }
    expect(zbusTip(tr, topo, [timedOut], row, placed)).toEqual([
      'publish · main',
      '-EAGAIN: timed out waiting for the channel',
    ])
  })

  it('blames the observer whose failure the publish returned', () => {
    const full: ZbusCall = {
      ...pub,
      ret: -35,
      notifies: pub.notifies.map((n) => (n.obs === BAR_SUB ? { ...n, ret: -35 } : n)),
    }
    const a: ZbusActivity = { ...activity, calls: [full, read, rejected] }
    const r = buildRows(topo, a)
    const placed = placeRows(r, a, topo)
    const acc = r.findIndex((x) => x.label === 'acc_data_chan')
    const bar = r.findIndex((x) => x.label === 'bar_sub')
    expect(zbusTip(tr, topo, a.calls, r[acc]!, placed[acc]![0]!)).toEqual(['publish · main', '-ENOMSG from bar_sub'])
    expect(zbusTip(tr, topo, a.calls, r[bar]!, placed[bar]![0]!)).toEqual([
      'bar_sub · channel queued',
      '-ENOMSG: queue full',
    ])
  })

  it("says a listener's callback ran inside the publish", () => {
    expect(tip('foo_lis', 'notify')).toEqual(['foo_lis · callback', "5.320ms, inside main's publish"])
  })

  it('times a wake and an async callback from the hand-off', () => {
    expect(tip('bar_sub', 'notify')).toEqual(['bar_sub · channel queued', '2.770ms'])
    expect(tip('bar_sub', 'wake')).toEqual(['subscriber_task_id woke', '1.250ms after the queue put'])
    expect(tip('baz_async_lis', 'run')).toEqual([
      'baz_async_lis · callback in sysworkq',
      '5.565ms, 2.910ms after the hand-off',
    ])
  })

  it('says a read began while another thread was publishing', () => {
    expect(tip('bar_sub', 'read')).toEqual(['read · subscriber_task_id', "13.585ms, began inside main's publish"])
  })

  it('says what a channel is, and what each kind of observer does, over the gutter', () => {
    expect(tip('acc_data_chan', null)).toEqual(['acc_data_chan', '12 B · 3 obs'])
    expect(tip('bar_sub', null)).toEqual(['bar_sub · subscriber', 'gets the channel, reads it later'])
    expect(tip('foo_lis', null)).toEqual(['foo_lis · listener', 'runs inside the publish'])
    const added: ZbusCall = { ...pub, notifies: [{ obs: 0x4001_9990, t0: ms(1), t1: ms(2), ret: 0 }] }
    const a: ZbusActivity = { calls: [added], wakes: [], runs: [] }
    const r = buildRows(topo, a)
    const i = r.findIndex((x) => x.label === '0x40019990')
    expect(zbusTip(tr, topo, a.calls, r[i]!, null)).toEqual([
      '0x40019990',
      'not in the image: added at run time',
    ])
  })

  it('says a call that has not returned is still running', () => {
    const open: ZbusCall = { ...pub, t1: null, ret: null }
    const placed: Placed = { ...items[rowOf('acc_data_chan')]![0]!, item: { kind: 'call', call: open } }
    expect(zbusTip(tr, topo, [open], rows[rowOf('acc_data_chan')]!, placed)).toEqual([
      'publish · main',
      'still running',
    ])
  })
})
