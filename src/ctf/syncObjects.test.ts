import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emptyCpuPower } from './cpuPower'
import { parseMetadata } from './metadata'
import type { Trace } from './reader'
import { reconstructSync, syncObjectKey, syncRouteKey, type SyncState } from './syncObjects'

// Thread and object addresses from the sensor pipeline on the Cortex-A53.
const AGG = 0x40021620
const STORAGE = 0x40020000
const C0 = 0x40021270
const C1 = 0x40020ec0
const IDLE = 0x40022a30
const BUS = 0x40012268
const FRAME = 0x400122a0
const COND = 0x40012330
const SEM = 0x40013000
const FOREVER = 0xffffd8f0

type Ev = [ts: number, name: string, fields?: Record<string, number>]

function trace(events: Ev[]): Trace {
  return {
    events: events.map(([ts, name, fields = {}], eid) => ({ ts, eid, name, fields })),
    threads: new Map(),
    segments: [],
    isrSpans: [],
    isrOpenStart: null,
    states: new Map(),
    stateStarts: new Map(),
    cpuPower: emptyCpuPower(),
    t0: events[0]?.[0] ?? 0,
    t1: events.at(-1)?.[0] ?? 0,
  }
}

const switchTo = (ts: number, from: number, to: number): Ev[] => [
  [ts, 'thread_switched_out', { thread_id: from }],
  [ts, 'thread_switched_in', { thread_id: to }],
]
const lock = (ts: number, id: number): Ev[] => [
  [ts, 'mutex_lock_enter', { id, timeout: FOREVER }],
  [ts + 1, 'mutex_lock_exit', { id, timeout: FOREVER, ret: 0 }],
]
const unlock = (ts: number, id: number): Ev[] => [
  [ts, 'mutex_unlock_enter', { id }],
  [ts + 1, 'mutex_unlock_exit', { id, ret: 0 }],
]
const prio = (ts: number, thread: number, p: number): Ev => [
  ts,
  'thread_sched_priority_set',
  { thread_id: thread, prio: p },
]

function replay(...parts: Ev[][]): SyncState {
  return reconstructSync(trace(parts.flat()))
}

function mutex(state: SyncState, id: number) {
  return state.objects.get(syncObjectKey('mutex', id))
}

/*
 * The aggregator (priority 3) finds the bus taken by storage (priority 9), as
 * the pipeline sample logs it: the boost, the hand-off named by the wake-up,
 * the aggregator's lock exit, and only then storage's own unlock exit.
 */
/** Storage holds the bus at the priority the waiting aggregator lent it. */
const busTaken: Ev[] = [
  [100, 'thread_switched_in', { thread_id: STORAGE }],
  prio(101, STORAGE, 9),
  prio(102, AGG, 3),
  ...lock(110, BUS),
  ...switchTo(120, STORAGE, AGG),
  [130, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
  [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
  prio(132, STORAGE, 3),
  [133, 'thread_sched_pend', { thread_id: AGG }],
  ...switchTo(134, AGG, STORAGE),
]
/** Storage unlocks, gives the priority back and wakes the aggregator, which runs at once. */
const busReleased: Ev[] = [
  [140, 'mutex_unlock_enter', { id: BUS }],
  prio(141, STORAGE, 9),
  [142, 'thread_sched_ready', { thread_id: AGG }],
  ...switchTo(143, STORAGE, AGG),
]
const busClaimed: Ev[] = [[150, 'mutex_lock_exit', { id: BUS, timeout: FOREVER, ret: 0 }]]
/** Storage only finishes its unlock when it runs again. */
const busLateExit: Ev[] = [
  ...switchTo(160, AGG, STORAGE),
  [161, 'mutex_unlock_exit', { id: BUS, ret: 0 }],
]

describe('reconstructSync: mutexes', () => {
  it('sees storage hold the bus at the priority the waiting aggregator lent it', () => {
    const state = replay(busTaken)
    expect(mutex(state, BUS)).toMatchObject({
      owner: STORAGE,
      depth: 1,
      waiters: [{ threadId: AGG, since: 131 }],
    })
    expect(state.inherited.get(STORAGE)).toEqual({ priority: 3, base: 9 })
  })

  it('hands the bus to the thread its unlock wakes, before either logs the exit', () => {
    const state = replay(busTaken, busReleased)
    expect(mutex(state, BUS)).toMatchObject({ owner: AGG, depth: 1, waiters: [] })
    expect(state.inherited.has(STORAGE)).toBe(false)
  })

  it('takes the late unlock exit of the old owner for what it is', () => {
    expect(mutex(replay(busTaken, busReleased, busClaimed), BUS)).toMatchObject({
      owner: AGG,
      depth: 1,
    })
    expect(
      mutex(replay(busTaken, busReleased, busClaimed, busLateExit), BUS),
    ).toMatchObject({ owner: AGG, depth: 1 })
  })

  it('lists one lock route per thread', () => {
    const routes = replay(busTaken, busReleased, busClaimed, busLateExit).routes.map(syncRouteKey)
    expect(routes).toEqual([
      `thread:${STORAGE}|mutex:${BUS}|lock`,
      `thread:${AGG}|mutex:${BUS}|lock`,
    ])
  })

  it('hands over the same way when the waiter runs after the releaser', () => {
    const released: Ev[] = [
      [100, 'thread_switched_in', { thread_id: AGG }],
      ...lock(110, BUS),
      ...switchTo(120, AGG, STORAGE),
      [130, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      ...switchTo(134, STORAGE, AGG),
      [140, 'mutex_unlock_enter', { id: BUS }],
      [142, 'thread_sched_ready', { thread_id: STORAGE }],
      [143, 'mutex_unlock_exit', { id: BUS, ret: 0 }],
    ]
    const claimed: Ev[] = [
      ...switchTo(150, AGG, STORAGE),
      [151, 'mutex_lock_exit', { id: BUS, timeout: FOREVER, ret: 0 }],
    ]
    // Between the releaser's exit and the waiter's, the waiter already owns it.
    expect(mutex(replay(released), BUS)).toMatchObject({ owner: STORAGE, waiters: [] })
    expect(mutex(replay(released, claimed), BUS)).toMatchObject({ owner: STORAGE, depth: 1 })
  })

  it('counts recursive locks', () => {
    const twice: Ev[] = [
      [100, 'thread_switched_in', { thread_id: AGG }],
      ...lock(110, BUS),
      ...lock(120, BUS),
    ]
    expect(mutex(replay(twice), BUS)).toMatchObject({ owner: AGG, depth: 2 })
    expect(mutex(replay(twice, unlock(130, BUS)), BUS)).toMatchObject({ owner: AGG, depth: 1 })
    expect(mutex(replay(twice, unlock(130, BUS), unlock(140, BUS)), BUS)).toMatchObject({
      owner: null,
      depth: 0,
    })
  })

  it('takes the lent priority back when the waiter times out', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      prio(101, STORAGE, 9),
      ...lock(110, BUS),
      ...switchTo(120, STORAGE, AGG),
      [130, 'mutex_lock_enter', { id: BUS, timeout: 1000 }],
      [131, 'mutex_lock_blocking', { id: BUS, timeout: 1000 }],
      prio(132, STORAGE, 3),
      ...switchTo(134, AGG, STORAGE),
      [140, 'isr_enter'],
      [141, 'thread_sched_ready', { thread_id: AGG }],
      [142, 'isr_exit'],
      ...switchTo(143, STORAGE, AGG),
      prio(150, STORAGE, 9),
      [151, 'mutex_lock_exit', { id: BUS, timeout: 1000, ret: -11 }],
    ]
    const state = replay(events)
    expect(mutex(state, BUS)).toMatchObject({ owner: STORAGE, waiters: [] })
    expect(state.inherited.has(STORAGE)).toBe(false)
  })

  it("takes the lent priority back on unlock when the owner's own priority never showed", () => {
    // Threads created at run time log no priority, so the boost has no base.
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      ...lock(110, BUS),
      ...switchTo(120, STORAGE, AGG),
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      prio(132, STORAGE, -2),
      ...switchTo(134, AGG, STORAGE),
    ]
    expect(replay(events).inherited.get(STORAGE)).toEqual({ priority: -2, base: null })
    const released: Ev[] = [
      [140, 'mutex_unlock_enter', { id: BUS }],
      prio(141, STORAGE, -1),
      [142, 'thread_sched_ready', { thread_id: AGG }],
    ]
    expect(replay(events, released).inherited.has(STORAGE)).toBe(false)
  })

  it('takes the base the trace never showed from the debugger', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      ...lock(110, BUS),
      ...switchTo(120, STORAGE, AGG),
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      prio(132, STORAGE, -2),
      ...switchTo(134, AGG, STORAGE),
    ]
    const read = (own: number) =>
      reconstructSync(trace(events), { priorities: new Map([[STORAGE, own]]) })
    expect(read(-1).inherited.get(STORAGE)).toEqual({ priority: -2, base: -1 })
    // Not less urgent than the loan: a reading of some other thread.
    expect(read(-2).inherited.get(STORAGE)).toEqual({ priority: -2, base: null })
  })

  it('keeps the loan a mutex still owes once the debugger gave the base', () => {
    // Philosopher 4 (own priority 0) takes its second fork while philosopher
    // 3 (-1) waits for its first, then philosopher 5 (-2) waits for the second.
    // Giving the second back restores the priority it was taken at, -1, which
    // only the base tells apart from the end of the loan.
    const [P3, P4, P5, FORK4, FORK5] = [0x30, 0x40, 0x50, 0x4400, 0x5500]
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: P4 }],
      ...lock(110, FORK4),
      ...switchTo(120, P4, P3),
      [121, 'mutex_lock_blocking', { id: FORK4, timeout: FOREVER }],
      prio(122, P4, -1),
      ...switchTo(123, P3, P4),
      ...lock(130, FORK5),
      ...switchTo(140, P4, P5),
      [141, 'mutex_lock_blocking', { id: FORK5, timeout: FOREVER }],
      prio(142, P4, -2),
      ...switchTo(143, P5, P4),
      [150, 'mutex_unlock_enter', { id: FORK5 }],
      prio(151, P4, -1),
      [152, 'thread_sched_ready', { thread_id: P5 }],
      [153, 'mutex_unlock_exit', { id: FORK5, ret: 0 }],
    ]
    const released: Ev[] = [
      [160, 'mutex_unlock_enter', { id: FORK4 }],
      prio(161, P4, 0),
      [162, 'thread_sched_ready', { thread_id: P3 }],
    ]
    const read = (...parts: Ev[][]) =>
      reconstructSync(trace(parts.flat()), { priorities: new Map([[P4, 0]]) })
    expect(read(events).inherited.get(P4)).toEqual({ priority: -1, base: 0 })
    expect(read(events, released).inherited.has(P4)).toBe(false)
    // Without the base, giving the second fork back looks like the end of it.
    expect(replay(events).inherited.has(P4)).toBe(false)
  })

  it('gives the lent priority back even when another mutex the owner holds has a waiter', () => {
    // Philosopher 4 holds both its forks; philosopher 3 (lower priority) waits
    // on one and lends nothing, philosopher 5 (higher) waits on the other.
    const [P3, P4, P5, FORK4, FORK5] = [0x30, 0x40, 0x50, 0x4400, 0x5500]
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: P4 }],
      ...lock(110, FORK4),
      ...lock(120, FORK5),
      ...switchTo(130, P4, P3),
      [131, 'mutex_lock_blocking', { id: FORK4, timeout: FOREVER }],
      ...switchTo(132, P3, P5),
      [141, 'mutex_lock_blocking', { id: FORK5, timeout: FOREVER }],
      prio(142, P4, -2),
      ...switchTo(143, P5, P4),
      [150, 'mutex_unlock_enter', { id: FORK5 }],
      prio(151, P4, -1),
      [152, 'thread_sched_ready', { thread_id: P5 }],
      [153, 'mutex_unlock_exit', { id: FORK5, ret: 0 }],
    ]
    const state = replay(events)
    expect(state.inherited.has(P4)).toBe(false)
    expect(mutex(state, FORK4)).toMatchObject({ owner: P4, waiters: [{ threadId: P3, since: 131 }] })
  })

  it('credits a block that shares its tick with the switch to the thread that blocked', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      ...lock(110, BUS),
      ...switchTo(120, STORAGE, AGG),
      [130, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
      [134, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      prio(134, STORAGE, 3),
      ...switchTo(134, AGG, STORAGE),
    ]
    const state = replay(events)
    // The schedule says storage runs from 134 on; the records say otherwise.
    const t = trace(events)
    t.segments = [
      [100, 120, STORAGE],
      [120, 134, AGG],
      [134, 200, STORAGE],
    ]
    expect(mutex(reconstructSync(t), BUS)?.waiters).toEqual([{ threadId: AGG, since: 134 }])
    expect(mutex(state, BUS)?.waiters).toEqual([{ threadId: AGG, since: 134 }])
    expect(state.inherited.get(STORAGE)).toEqual({ priority: 3, base: null })
  })

  it('learns the owner of a mutex held before the trace began from its unlock', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: AGG }],
      [130, 'mutex_lock_enter', { id: BUS, timeout: FOREVER }],
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      ...switchTo(134, AGG, STORAGE),
      [140, 'mutex_unlock_enter', { id: BUS }],
      [142, 'thread_sched_ready', { thread_id: AGG }],
      [143, 'mutex_unlock_exit', { id: BUS, ret: 0 }],
    ]
    expect(mutex(replay(events.slice(0, 3)), BUS)).toMatchObject({ owner: 'unknown' })
    expect(mutex(replay(events), BUS)).toMatchObject({ owner: AGG, waiters: [] })
  })

  it('forgets what a failed unlock taught it', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: AGG }],
      [140, 'mutex_unlock_enter', { id: BUS }],
      [141, 'mutex_unlock_exit', { id: BUS, ret: -1 }],
    ]
    expect(mutex(replay(events), BUS)).toMatchObject({ owner: null })
  })

  it('drops a waiter whose thread was aborted', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: STORAGE }],
      ...lock(110, BUS),
      ...switchTo(120, STORAGE, AGG),
      [131, 'mutex_lock_blocking', { id: BUS, timeout: FOREVER }],
      ...switchTo(134, AGG, STORAGE),
      [140, 'thread_abort', { thread_id: AGG }],
    ]
    expect(mutex(replay(events), BUS)?.waiters).toEqual([])
  })

  it('ignores a mutex record from an interrupt', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: AGG }],
      [110, 'isr_enter'],
      ...lock(111, BUS),
      [113, 'isr_exit'],
    ]
    expect(replay(events).routes).toEqual([])
  })
})

describe('reconstructSync: condition variables', () => {
  const wait = (ts: number, thread: number, next: number): Ev[] => [
    ...lock(ts, FRAME),
    [ts + 2, 'condvar_wait_enter', { id: COND, timeout: FOREVER }],
    ...unlock(ts + 3, FRAME),
    [ts + 5, 'thread_sched_pend', { thread_id: thread }],
    ...switchTo(ts + 6, thread, next),
  ]
  const waiting: Ev[] = [
    [100, 'thread_switched_in', { thread_id: C0 }],
    ...wait(110, C0, C1),
    ...wait(120, C1, AGG),
  ]
  /** The aggregator publishes a frame, and the first consumer takes the mutex back. */
  const published: Ev[] = [
    ...lock(130, FRAME),
    [132, 'condvar_broadcast_enter', { id: COND }],
    [133, 'thread_sched_ready', { thread_id: C0 }],
    [134, 'thread_sched_ready', { thread_id: C1 }],
    [135, 'condvar_broadcast_exit', { id: COND, ret: 2 }],
    ...unlock(136, FRAME),
    ...switchTo(140, AGG, C0),
    ...lock(141, FRAME),
    [143, 'condvar_wait_exit', { id: COND, timeout: FOREVER, ret: 0 }],
  ]

  it('lists the threads waiting, and learns the mutex they give up', () => {
    const state = replay(waiting)
    expect(state.objects.get(syncObjectKey('condvar', COND))).toMatchObject({
      waiters: [
        { threadId: C0, since: 112 },
        { threadId: C1, since: 122 },
      ],
      mutexId: FRAME,
    })
    expect(mutex(state, FRAME)).toMatchObject({ owner: null })
  })

  it('stops counting a waiter once the broadcast wakes it', () => {
    const state = replay(waiting, published)
    expect(state.objects.get(syncObjectKey('condvar', COND))?.waiters).toEqual([])
    expect(mutex(state, FRAME)).toMatchObject({ owner: C0, depth: 1 })
    expect(state.routes.map(syncRouteKey)).toContain(`thread:${AGG}|condvar:${COND}|signal`)
    expect(state.routes.map(syncRouteKey)).toContain(`thread:${C1}|condvar:${COND}|wait`)
  })

  it('does not take a signal that wakes a waiter for the signaller blocking', () => {
    const signal: Ev[] = [
      [100, 'thread_switched_in', { thread_id: C0 }],
      ...wait(110, C0, AGG),
      [130, 'condvar_signal_enter', { id: COND }],
      [131, 'condvar_signal_blocking', { id: COND, timeout: FOREVER }],
      [132, 'thread_sched_ready', { thread_id: C0 }],
      [133, 'condvar_signal_exit', { id: COND, ret: 0 }],
    ]
    const state = replay(signal)
    expect(state.objects.get(syncObjectKey('condvar', COND))?.waiters).toEqual([])
    expect([...state.objects.values()].flatMap((o) => o.waiters)).toEqual([])
  })
})

describe('reconstructSync: semaphores', () => {
  it('serves a waiter from an interrupt', () => {
    const events: Ev[] = [
      [100, 'thread_switched_in', { thread_id: C0 }],
      [110, 'semaphore_take_enter', { id: SEM, timeout: FOREVER }],
      [111, 'semaphore_take_blocking', { id: SEM, timeout: FOREVER }],
      ...switchTo(112, C0, IDLE),
      [120, 'isr_enter'],
      [121, 'semaphore_give_enter', { id: SEM }],
      [122, 'thread_sched_ready', { thread_id: C0 }],
      [123, 'semaphore_give_exit', { id: SEM }],
      [124, 'isr_exit'],
    ]
    const waiting = replay(events.slice(0, 5)).objects.get(syncObjectKey('sem', SEM))
    expect(waiting?.waiters).toEqual([{ threadId: C0, since: 111 }])
    const state = replay(events)
    expect(state.objects.get(syncObjectKey('sem', SEM))?.waiters).toEqual([])
    expect(state.routes.map(syncRouteKey)).toEqual([
      `thread:${C0}|sem:${SEM}|take`,
      `isr|sem:${SEM}|give`,
    ])
  })
})

describe('the CTF table', () => {
  it('names the fields the reconstruction reads', () => {
    const defs = parseMetadata(readFileSync('public/tracing/metadata', 'utf8'))
    const fields = new Map([...defs.values()].map((d) => [d.name, d.fields.map((f) => f.name)]))
    for (const name of [
      'mutex_lock_exit',
      'mutex_unlock_exit',
      'semaphore_take_exit',
      'condvar_wait_exit',
    ]) {
      expect(fields.get(name)).toEqual(expect.arrayContaining(['id', 'ret']))
    }
    for (const name of ['mutex_lock_blocking', 'semaphore_give_enter', 'condvar_broadcast_enter']) {
      expect(fields.get(name)).toContain('id')
    }
    expect(fields.get('thread_sched_ready')).toContain('thread_id')
    expect(fields.get('thread_sched_priority_set')).toEqual(
      expect.arrayContaining(['thread_id', 'prio']),
    )
  })
})
