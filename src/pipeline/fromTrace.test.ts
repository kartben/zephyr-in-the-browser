import { describe, expect, it } from 'vitest'
import type { Trace, ThreadInfo, StateSeg, CtfEvent } from '@/ctf'
import { HOT_NS, pipelineFromTrace } from './fromTrace'

function thread(name: string, prio: number): ThreadInfo {
  return { name, prio, stackBase: null, stackSize: null }
}

function makeTrace(opts: {
  threads: Array<[number, ThreadInfo]>
  states: Array<[number, StateSeg[]]>
  events?: CtfEvent[]
  t1: number
}): Trace {
  const states = new Map(opts.states)
  const stateStarts = new Map<number, number[]>()
  for (const [tid, segs] of states) {
    stateStarts.set(
      tid,
      segs.map((s) => s[0]),
    )
  }
  return {
    events: opts.events ?? [],
    threads: new Map(opts.threads),
    segments: [],
    isrSpans: [],
    states,
    stateStarts,
    t0: 0,
    t1: opts.t1,
  }
}

describe('pipelineFromTrace', () => {
  it('colours nodes from live thread state and lights blocked edges', () => {
    const tr = makeTrace({
      t1: 1_000_000,
      threads: [
        [1, thread('sensor_temp', 8)],
        [2, thread('aggregator', 3)],
        [3, thread('consumer0', 6)],
        [4, thread('storage', 9)],
      ],
      states: [
        [1, [[0, 1_000_000, 'slp', '']]],
        [2, [[0, 1_000_000, 'blk', 'msgq 0xabc']]],
        [3, [[0, 1_000_000, 'blk', 'condvar 0xdef']]],
        [4, [[0, 1_000_000, 'run', '']]],
      ],
    })
    const live = pipelineFromTrace(tr)
    expect(live.nodes.find((n) => n.id === 'sensor_temp')?.state).toBe('slp')
    expect(live.nodes.find((n) => n.id === 'aggregator')?.state).toBe('blk')
    expect(live.nodes.find((n) => n.id === 'storage')?.state).toBe('run')
    expect(live.edges.find((e) => e.id === 'sensor_q')?.hot).toBe(true)
    expect(live.edges.find((e) => e.id === 'sensor_q')?.waiter).toBe('aggregator')
    expect(live.edges.find((e) => e.id === 'frame')?.waiter).toBe('consumer0')
  })

  it('flashes nodes from recent named_event markers and tracks frame seq', () => {
    const t1 = 10_000_000_000
    const tr = makeTrace({
      t1,
      threads: [
        [1, thread('sensor_imu', 8)],
        [2, thread('aggregator', 3)],
        [3, thread('consumer1', 6)],
      ],
      states: [
        [1, [[0, t1, 'run', '']]],
        [2, [[0, t1, 'rdy', '']]],
        [3, [[0, t1, 'rdy', '']]],
      ],
      events: [
        {
          ts: t1 - HOT_NS / 2,
          eid: 0x62,
          name: 'named_event',
          fields: { name: 'sensor_sample', arg0: 2, arg1: 42 },
        },
        {
          ts: t1 - HOT_NS / 4,
          eid: 0x62,
          name: 'named_event',
          fields: { name: 'frame_publish', arg0: 7, arg1: 19 },
        },
        {
          ts: t1 - HOT_NS / 5,
          eid: 0x62,
          name: 'named_event',
          fields: { name: 'consume_begin', arg0: 1, arg1: 7 },
        },
        {
          ts: t1 - HOT_NS / 6,
          eid: 0x62,
          name: 'named_event',
          fields: { name: 'flush', arg0: 7, arg1: 3 },
        },
        // Stale — must not flash.
        {
          ts: t1 - HOT_NS * 4,
          eid: 0x62,
          name: 'named_event',
          fields: { name: 'store_begin', arg0: 0, arg1: 0 },
        },
      ],
    })
    const live = pipelineFromTrace(tr)
    expect(live.nodes.find((n) => n.id === 'sensor_imu')?.flash).toBe(true)
    expect(live.nodes.find((n) => n.id === 'aggregator')?.flash).toBe(true)
    expect(live.nodes.find((n) => n.id === 'consumer1')?.flash).toBe(true)
    expect(live.nodes.find((n) => n.id === 'storage')?.flash).toBe(false)
    expect(live.frameSeq).toBe(7)
    expect(live.frameAvg).toBe(19)
    expect(live.msgqDepth).toBe(3)
    expect(live.edges.find((e) => e.id === 'sensor_q')?.hot).toBe(true)
    expect(live.edges.find((e) => e.id === 'frame')?.hot).toBe(true)
  })
})
