/**
 * Who holds, waits on and signals each semaphore, mutex and condition variable,
 * rebuilt from their CTF events for the IPC graph: the state at the last
 * retained event, plus every route an actor took to an object.
 *
 * The events carry the object's address and a return value, never the thread,
 * so each is credited to the thread running when it was recorded. That thread
 * is followed in record order, from the switch events, not looked up by
 * timestamp: a waiter's `mutex_lock_blocking`, the owner's priority boost and
 * the switch away from the waiter can share a clock tick, and a lookup by time
 * would credit them to the thread switched to.
 *
 * A release hands over before it is logged as done. `k_mutex_unlock` and
 * `k_sem_give` log their exit after the reschedule, so a waiter that outranks
 * the releaser logs taking the object before the releaser logs letting go.
 * What names the thread that got it is the `thread_sched_ready` the release
 * logs for it, between the release's enter and its exit; a condvar's signal or
 * broadcast logs one for each waiter it wakes. A release's exit only settles
 * what nothing woken did: the mutex is free.
 *
 * A condvar wait logs no mutex. The mutex it gives up shows as an unlock nested
 * inside the wait, which is how a condvar here learns its mutex.
 */

import { isrDepthAtStart, queueActorKey, type QueueActor } from './queueGraph'
import { scheduledThreadAt, type CtfEvent, type Trace } from './reader'

export type SyncKind = 'sem' | 'mutex' | 'condvar'

/**
 * What an actor did to an object. give and signal make something available,
 * take and wait wait for it, and lock is both, on a mutex.
 */
export type SyncOp = 'give' | 'take' | 'signal' | 'wait' | 'lock'

export interface SyncWaiter {
  threadId: number
  /** When it started waiting. */
  since: number
}

export interface SyncObject {
  kind: SyncKind
  id: number
  /** mutex: its owner, 'unknown' when the trace began while it was held, or null when free. */
  owner: number | 'unknown' | null
  /** mutex: how many times the owner holds it. */
  depth: number
  /** Threads blocked on it now, longest waiting first. */
  waiters: SyncWaiter[]
  /** condvar: the mutex its waiters give up while they wait. */
  mutexId: number | null
}

export type SyncActor = Exclude<QueueActor, { kind: 'unknown' }>

export interface SyncRoute {
  kind: SyncKind
  objectId: number
  actor: SyncActor
  op: SyncOp
}

/** A thread running at the priority of a thread waiting on a mutex it holds. */
export interface InheritedPriority {
  priority: number
  /** Its own priority, when the trace has shown it. */
  base: number | null
}

export interface SyncState {
  /** Keyed by {@link syncObjectKey}. */
  objects: Map<string, SyncObject>
  /** One per actor, object and op, in the order first seen. */
  routes: SyncRoute[]
  inherited: Map<number, InheritedPriority>
}

export function syncObjectKey(kind: SyncKind, id: number): string {
  return `${kind}:${id}`
}

export function syncRouteKey(route: SyncRoute): string {
  return `${queueActorKey(route.actor)}|${syncObjectKey(route.kind, route.objectId)}|${route.op}`
}

const KIND_OF_PREFIX: Array<[string, SyncKind]> = [
  ['semaphore_', 'sem'],
  ['mutex_', 'mutex'],
  ['condvar_', 'condvar'],
]

function syncKind(name: string): SyncKind | null {
  for (const [prefix, kind] of KIND_OF_PREFIX) if (name.startsWith(prefix)) return kind
  return null
}

function num(value: string | number | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/** What a thread is in the middle of, as far as these objects go. */
interface ThreadDoing {
  /** The mutex it logged blocking on, until it is switched out. */
  blockingOn: string | null
  /** The release it is inside (unlock, give, signal, broadcast). */
  releasing: string | null
  /** The condvar it waits on, from wait_enter to wait_exit. */
  condvarWait: string | null
}

interface MutableObject extends SyncObject {
  /** mutex: handed to `owner` by a release, which has not logged taking it yet. */
  awaitingExit: boolean
  /** mutex: the owner before an unlock taught us who held it, in case that unlock fails. */
  learnedFrom: number | 'unknown' | null | undefined
}

export function reconstructSync(tr: Trace): SyncState {
  const objects = new Map<string, MutableObject>()
  const routes = new Map<string, SyncRoute>()
  const inherited = new Map<number, InheritedPriority>()
  const priority = new Map<number, number>()
  const doing = new Map<number, ThreadDoing>()
  let isrReleasing: string | null = null
  let isrDepth = isrDepthAtStart(tr)
  // Unknown until the first switch in the retained log; until then, ask the
  // schedule, which is kept whole when the event log is trimmed.
  let current: number | null = null

  const threadDoing = (tid: number): ThreadDoing => {
    let d = doing.get(tid)
    if (!d) {
      d = { blockingOn: null, releasing: null, condvarWait: null }
      doing.set(tid, d)
    }
    return d
  }

  const object = (kind: SyncKind, id: number): MutableObject => {
    const key = syncObjectKey(kind, id)
    let o = objects.get(key)
    if (!o) {
      o = {
        kind,
        id,
        owner: null,
        depth: 0,
        waiters: [],
        mutexId: null,
        awaitingExit: false,
        learnedFrom: undefined,
      }
      objects.set(key, o)
    }
    return o
  }

  const addWaiter = (o: MutableObject, threadId: number, since: number) => {
    if (!o.waiters.some((w) => w.threadId === threadId)) o.waiters.push({ threadId, since })
  }

  const removeWaiter = (o: MutableObject, threadId: number): boolean => {
    const i = o.waiters.findIndex((w) => w.threadId === threadId)
    if (i < 0) return false
    o.waiters.splice(i, 1)
    return true
  }

  const waitsOnMutexOf = (waiter: number, owner: number): boolean => {
    for (const o of objects.values()) {
      if (o.kind === 'mutex' && o.owner === owner && o.waiters.some((w) => w.threadId === waiter)) {
        return true
      }
    }
    return false
  }

  /*
   * A priority change logged by a thread blocking on a mutex, or by one of its
   * waiters timing out, is the owner's priority being lent or taken back. One
   * logged by the owner inside its own unlock is it giving the lent priority
   * back. Anything else is the thread's own priority changing.
   */
  const onPriority = (target: number, prio: number, actor: number | null) => {
    const before = priority.get(target) ?? null
    priority.set(target, prio)
    const lent =
      actor !== null &&
      actor !== target &&
      (threadDoing(actor).blockingOn !== null || waitsOnMutexOf(actor, target))
    const held = inherited.get(target)
    if (lent) {
      const base = held ? held.base : before
      if (base !== null && prio === base) inherited.delete(target)
      else inherited.set(target, { priority: prio, base })
      return
    }
    const restoring =
      actor === target && threadDoing(target).releasing?.startsWith('mutex:') === true
    if (restoring && held) {
      // A thread created at run time logs no priority of its own, so its
      // boost has no base: a restore that lowers its priority gives the boost
      // back. Whether its other mutexes have waiters says nothing, since a
      // waiter only lends a priority higher than the owner's.
      const back = held.base === null ? prio > held.priority : prio === held.base
      if (back) inherited.delete(target)
      else inherited.set(target, { priority: prio, base: held.base })
      return
    }
    inherited.delete(target)
  }

  /** A thread a release woke: the mutex is its now; on anything else, it stops waiting. */
  const onWoken = (key: string, woken: number, releaser: ThreadDoing | null) => {
    const o = objects.get(key)
    if (!o || !removeWaiter(o, woken)) return
    if (o.kind !== 'mutex') return
    o.owner = woken
    o.depth = 1
    o.awaitingExit = true
    o.learnedFrom = undefined
    if (releaser) releaser.releasing = null
  }

  const route = (kind: SyncKind, id: number, actor: SyncActor, op: SyncOp) => {
    const r: SyncRoute = { kind, objectId: id, actor, op }
    const key = syncRouteKey(r)
    if (!routes.has(key)) routes.set(key, r)
  }

  const runningThread = (ev: CtfEvent): number | null => current ?? scheduledThreadAt(tr, ev.ts)

  for (const ev of tr.events) {
    const name = ev.name
    if (isrDepth > 0 && (name === 'thread_switched_in' || name === 'thread_switched_out')) {
      // The same recovery as the reader's when an ISR exit was lost.
      isrDepth = 0
      isrReleasing = null
    }
    if (name === 'isr_enter') {
      isrDepth++
      continue
    }
    if (name === 'isr_exit' || name === 'isr_exit_to_scheduler') {
      if (isrDepth > 0) isrDepth--
      if (isrDepth === 0) isrReleasing = null
      continue
    }

    const tid = num(ev.fields.thread_id)
    if (name === 'thread_switched_in') {
      if (tid !== null) current = tid
      continue
    }
    if (name === 'thread_switched_out') {
      if (tid !== null) threadDoing(tid).blockingOn = null
      continue
    }
    if (name === 'thread_priority_set' || name === 'thread_sched_priority_set') {
      const prio = num(ev.fields.prio)
      if (tid !== null && prio !== null) {
        onPriority(tid, prio, isrDepth > 0 ? null : runningThread(ev))
      }
      continue
    }
    if (name === 'thread_sched_ready') {
      if (tid === null) continue
      if (isrDepth > 0) {
        if (isrReleasing) onWoken(isrReleasing, tid, null)
        continue
      }
      const actor = runningThread(ev)
      const releaser = actor === null ? null : threadDoing(actor)
      if (releaser?.releasing) onWoken(releaser.releasing, tid, releaser)
      continue
    }
    if (name === 'thread_abort' || name === 'thread_sched_abort') {
      if (tid !== null) for (const o of objects.values()) removeWaiter(o, tid)
      continue
    }

    const kind = syncKind(name)
    if (!kind) continue
    const id = num(ev.fields.id)
    if (id === null) continue
    const key = syncObjectKey(kind, id)
    const thread = isrDepth > 0 ? null : runningThread(ev)
    const actor: SyncActor | null =
      isrDepth > 0 ? { kind: 'isr' } : thread === null ? null : { kind: 'thread', threadId: thread }
    if (!actor) continue
    const ret = num(ev.fields.ret)

    if (kind === 'mutex') {
      // Mutexes cannot be used from an interrupt; a record that says so is noise.
      if (thread === null) continue
      const m = object('mutex', id)
      const d = threadDoing(thread)
      switch (name) {
        case 'mutex_lock_enter': {
          route('mutex', id, actor, 'lock')
          // A condvar waiter taking its mutex back has been woken.
          const cw = d.condvarWait === null ? undefined : objects.get(d.condvarWait)
          if (cw?.mutexId === id) removeWaiter(cw, thread)
          break
        }
        case 'mutex_lock_blocking':
          route('mutex', id, actor, 'lock')
          addWaiter(m, thread, ev.ts)
          if (m.owner === null) m.owner = 'unknown'
          d.blockingOn = key
          break
        case 'mutex_lock_exit':
          route('mutex', id, actor, 'lock')
          removeWaiter(m, thread)
          d.blockingOn = null
          if (ret === 0) {
            if (m.owner === thread && m.awaitingExit) m.awaitingExit = false
            else if (m.owner === thread) m.depth += 1
            else {
              m.owner = thread
              m.depth = 1
              m.awaitingExit = false
            }
            m.learnedFrom = undefined
          } else if (m.owner === thread && m.awaitingExit) {
            m.owner = 'unknown'
            m.awaitingExit = false
          }
          break
        case 'mutex_unlock_enter': {
          route('mutex', id, actor, 'lock')
          if (m.owner === null || m.owner === 'unknown') {
            // The trace began while it was held: whoever unlocks it held it.
            m.learnedFrom = m.owner
            m.owner = thread
            m.depth = 1
          }
          if (m.owner !== thread) break
          const cw = d.condvarWait === null ? undefined : objects.get(d.condvarWait)
          if (cw && cw.mutexId === null) cw.mutexId = id
          if (m.depth > 1) m.depth -= 1
          else d.releasing = key
          break
        }
        case 'mutex_unlock_exit':
          if (d.releasing === key) {
            d.releasing = null
            if (m.owner === thread) {
              if (ret === 0) {
                m.owner = null
                m.depth = 0
              } else if (m.learnedFrom !== undefined) {
                m.owner = m.learnedFrom
                m.depth = 0
              }
            }
          }
          m.learnedFrom = undefined
          break
      }
      continue
    }

    const o = object(kind, id)
    const releasing = (on: boolean) => {
      if (thread === null) isrReleasing = on ? key : null
      else threadDoing(thread).releasing = on ? key : null
    }
    switch (name) {
      case 'semaphore_give_enter':
        route('sem', id, actor, 'give')
        releasing(true)
        break
      case 'semaphore_give_exit':
        releasing(false)
        break
      case 'semaphore_take_enter':
        route('sem', id, actor, 'take')
        break
      case 'semaphore_take_blocking':
        route('sem', id, actor, 'take')
        if (thread !== null) addWaiter(o, thread, ev.ts)
        break
      case 'semaphore_take_exit':
        if (thread !== null) removeWaiter(o, thread)
        break
      case 'condvar_signal_enter':
      case 'condvar_broadcast_enter':
        route('condvar', id, actor, 'signal')
        releasing(true)
        break
      case 'condvar_signal_exit':
      case 'condvar_broadcast_exit':
        releasing(false)
        break
      case 'condvar_wait_enter':
        route('condvar', id, actor, 'wait')
        if (thread !== null) {
          addWaiter(o, thread, ev.ts)
          threadDoing(thread).condvarWait = key
        }
        break
      case 'condvar_wait_exit':
        if (thread !== null) {
          removeWaiter(o, thread)
          threadDoing(thread).condvarWait = null
        }
        break
    }
  }

  const out = new Map<string, SyncObject>()
  for (const [key, o] of objects) {
    out.set(key, {
      kind: o.kind,
      id: o.id,
      owner: o.owner,
      depth: o.depth,
      waiters: o.waiters,
      mutexId: o.mutexId,
    })
  }
  return { objects: out, routes: [...routes.values()], inherited }
}
