/**
 * Reconstruct zbus activity from the `zbus_*` CTF events.
 *
 * The events come from zbus tracing hooks that upstream Zephyr does not have
 * yet (docs/trace-zbus.md). Each carries addresses only: a channel, an
 * observer, an async listener's work item. debug/elfZbus.ts names them.
 *
 * What a trace can say about a channel, and how it is put back together:
 *
 * - **Calls.** `zbus_chan_{pub,read,notify,claim,finish}_enter` and `_exit`
 *   bracket each call. They are paired per calling context (a thread, or
 *   interrupt context), on a stack, because a listener can publish to another
 *   channel from inside a publish.
 * - **Notifications.** The dispatcher brackets each observer it tells with
 *   `zbus_obs_notify_enter` / `_exit`, inside the publish or notify that
 *   started it. For a listener that span is the callback itself.
 * - **Wake-ups.** A subscriber's `zbus_sub_wait_exit` (or a message
 *   subscriber's `zbus_sub_wait_msg_exit`) names the channel that woke it.
 * - **Async runs.** `zbus_async_listener_enter` / `_exit` bracket an async
 *   listener's callback, in the work queue thread that runs it.
 *
 * The calling thread is the one the scheduler had running at the event's time,
 * and null in an interrupt handler.
 */

import { threadRunningAt, type Trace } from './reader'

export type ZbusChanOp = 'pub' | 'read' | 'notify' | 'claim' | 'finish'

export interface ZbusNotify {
  /** Observer address, low 32 bits, as the event recorded it. */
  obs: number
  t0: number
  /** Null while the dispatcher is still in it. */
  t1: number | null
  ret: number | null
}

export interface ZbusCall {
  op: ZbusChanOp
  /** Channel address, low 32 bits. */
  chan: number
  /** Calling thread; null in an interrupt handler. */
  thread: number | null
  t0: number
  /** Null while the call has not returned. */
  t1: number | null
  ret: number | null
  /** Timeout in microseconds, as the event recorded it; null for finish. */
  timeoutUs: number | null
  /** Observers the dispatcher told, in order. Publish and notify only. */
  notifies: ZbusNotify[]
}

export interface ZbusWake {
  /** The subscriber or message subscriber that waited. */
  obs: number
  /** The channel that woke it; null when the wait failed or timed out. */
  chan: number | null
  t: number
  /** When it started waiting, when the trace has that. */
  since: number | null
  thread: number | null
  ret: number
  /** A message subscriber (`zbus_sub_wait_msg`), which gets a copy of the message. */
  msg: boolean
}

export interface ZbusAsyncRun {
  /** The async listener's work item, low 32 bits. */
  work: number
  chan: number
  thread: number | null
  t0: number
  t1: number | null
}

export interface ZbusActivity {
  /** In order of t0. */
  calls: ZbusCall[]
  wakes: ZbusWake[]
  runs: ZbusAsyncRun[]
}

const CALL = /^zbus_chan_(pub|read|notify|claim|finish)_(enter|exit)$/

function num(fields: Record<string, string | number>, key: string): number | null {
  const v = fields[key]
  return typeof v === 'number' ? v : null
}

/** Whether the trace has any zbus events at all: the guest has the hooks. */
export function hasZbusEvents(tr: Trace): boolean {
  return tr.events.some((e) => e.name.startsWith('zbus_'))
}

/** Interrupt context gets its own stack, apart from any thread. */
const ISR = -1

export function reconstructZbus(tr: Trace): ZbusActivity {
  const calls: ZbusCall[] = []
  const wakes: ZbusWake[] = []
  const runs: ZbusAsyncRun[] = []
  const openCalls = new Map<number, ZbusCall[]>()
  const openNotifies = new Map<number, ZbusNotify[]>()
  const openRuns = new Map<number, ZbusAsyncRun[]>()
  const waitingSince = new Map<string, number>()
  const stack = <T>(m: Map<number, T[]>, key: number): T[] => {
    let s = m.get(key)
    if (!s) m.set(key, (s = []))
    return s
  }
  /** Remove and return the innermost open entry `match` accepts. */
  const popMatch = <T>(s: T[], match: (x: T) => boolean): T | null => {
    for (let i = s.length - 1; i >= 0; i--) {
      if (match(s[i]!)) return s.splice(i, 1)[0]!
    }
    return null
  }

  for (const e of tr.events) {
    if (!e.name.startsWith('zbus_')) continue
    const thread = threadRunningAt(tr, e.ts)
    const ctx = thread ?? ISR
    const f = e.fields
    const call = CALL.exec(e.name)
    if (call) {
      const op = call[1] as ZbusChanOp
      const chan = num(f, 'id')
      if (chan === null) continue
      if (call[2] === 'enter') {
        const c: ZbusCall = {
          op,
          chan,
          thread,
          t0: e.ts,
          t1: null,
          ret: null,
          timeoutUs: num(f, 'timeout'),
          notifies: [],
        }
        calls.push(c)
        stack(openCalls, ctx).push(c)
      } else {
        const c = popMatch(stack(openCalls, ctx), (x) => x.op === op && x.chan === chan)
        if (c) {
          c.t1 = e.ts
          c.ret = num(f, 'ret')
        }
      }
      continue
    }
    switch (e.name) {
      case 'zbus_obs_notify_enter': {
        const obs = num(f, 'id')
        const chan = num(f, 'chan')
        if (obs === null || chan === null) break
        const n: ZbusNotify = { obs, t0: e.ts, t1: null, ret: null }
        const owner = [...stack(openCalls, ctx)]
          .reverse()
          .find((c) => c.chan === chan && (c.op === 'pub' || c.op === 'notify'))
        owner?.notifies.push(n)
        stack(openNotifies, ctx).push(n)
        break
      }
      case 'zbus_obs_notify_exit': {
        const obs = num(f, 'id')
        const n = popMatch(stack(openNotifies, ctx), (x) => x.obs === obs)
        if (n) {
          n.t1 = e.ts
          n.ret = num(f, 'ret')
        }
        break
      }
      case 'zbus_sub_wait_enter':
      case 'zbus_sub_wait_msg_enter': {
        const obs = num(f, 'id')
        if (obs !== null) waitingSince.set(`${ctx}:${obs}`, e.ts)
        break
      }
      case 'zbus_sub_wait_exit':
      case 'zbus_sub_wait_msg_exit': {
        const obs = num(f, 'id')
        if (obs === null) break
        const key = `${ctx}:${obs}`
        const chan = num(f, 'chan')
        wakes.push({
          obs,
          chan: chan ? chan : null,
          t: e.ts,
          since: waitingSince.get(key) ?? null,
          thread,
          ret: num(f, 'ret') ?? 0,
          msg: e.name === 'zbus_sub_wait_msg_exit',
        })
        waitingSince.delete(key)
        break
      }
      case 'zbus_async_listener_enter': {
        const work = num(f, 'id')
        const chan = num(f, 'chan')
        if (work === null || chan === null) break
        const r: ZbusAsyncRun = { work, chan, thread, t0: e.ts, t1: null }
        runs.push(r)
        stack(openRuns, ctx).push(r)
        break
      }
      case 'zbus_async_listener_exit': {
        const work = num(f, 'id')
        const r = popMatch(stack(openRuns, ctx), (x) => x.work === work)
        if (r) r.t1 = e.ts
        break
      }
    }
  }
  return { calls, wakes, runs }
}

/** Counts over a time window, for the summary line above the lanes. */
export interface ZbusWindowStats {
  publishes: number
  rejected: number
  notifications: number
  reads: number
}

export function zbusWindowStats(a: ZbusActivity, view0: number, view1: number): ZbusWindowStats {
  const stats: ZbusWindowStats = { publishes: 0, rejected: 0, notifications: 0, reads: 0 }
  for (const c of a.calls) {
    if (c.t0 > view1 || (c.t1 ?? c.t0) < view0) continue
    if (c.op === 'pub') {
      stats.publishes++
      if (c.ret !== null && c.ret < 0) stats.rejected++
    } else if (c.op === 'read') stats.reads++
    for (const n of c.notifies) if (n.t0 >= view0 && n.t0 <= view1) stats.notifications++
  }
  return stats
}

/** `-ENOMSG` and friends for the errnos zbus calls return, else the number. */
export function zbusErrno(ret: number): string {
  const names: Record<number, string> = {
    [-35]: '-ENOMSG',
    [-11]: '-EAGAIN',
    [-12]: '-ENOMEM',
    [-16]: '-EBUSY',
    [-14]: '-EFAULT',
    [-3]: '-ESRCH',
    [-116]: '-ETIMEDOUT',
  }
  return names[ret] ?? String(ret)
}
