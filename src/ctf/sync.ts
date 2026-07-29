/**
 * Reconstruct per-object hold / wait / handoff timelines from CTF
 * semaphore_*, mutex_*, and condvar_* events.
 *
 * Events carry the object address (`id`) and result codes — not a ready-made
 * owner field. Owner, count, and waiters are recovered the same way Queues
 * recovers depth: from successful exits and blocking enters, with the running
 * thread at `ts` as the actor.
 */

import { threadPrio, threadRunningAt, type Trace } from './reader'

export type SyncKind = 'mutex' | 'sem' | 'condvar'

export type SyncOp =
  | 'init'
  | 'give'
  | 'take'
  | 'reset'
  | 'lock'
  | 'unlock'
  | 'wait'
  | 'signal'
  | 'broadcast'

export interface SyncMark {
  ts: number
  op: SyncOp
  ok: boolean
  threadId: number | null
  /** True when this mark came from a blocking enter (wait started). */
  blocking?: boolean
  /** Mutex lock depth or sem count after the op, when known. */
  value?: number
  ownerId?: number | null
  inversion?: boolean
}

/** Continuous hold of a mutex by one thread. */
export interface SyncHoldSeg {
  start: number
  end: number
  ownerId: number
  lockDepth: number
  /** True while a higher-priority thread was waiting on this hold. */
  inversion: boolean
}

/** Thread waiting on an object. */
export interface SyncWaitSeg {
  start: number
  end: number
  threadId: number
  inversion: boolean
}

/** Unlock / give → next successful claim. */
export interface SyncHandoff {
  ts: number
  fromId: number | null
  toId: number
}

export interface SyncCountSample {
  ts: number
  count: number
}

export interface SyncSeries {
  id: number
  kind: SyncKind
  name: string | null
  marks: SyncMark[]
  holdSegs: SyncHoldSeg[]
  waitSegs: SyncWaitSeg[]
  handoffs: SyncHandoff[]
  /**
   * Semaphore count step series. Relative — assumes 0 at first sight unless a
   * reset clears it (init does not carry the starting count in CTF).
   */
  countSamples: SyncCountSample[]
  peakWaiters: number
  inversionCount: number
  firstTs: number
  lastTs: number
}

type WaitAcc = { start: number; inversion: boolean }

type Acc = {
  kind: SyncKind
  marks: SyncMark[]
  holdSegs: SyncHoldSeg[]
  waitSegs: SyncWaitSeg[]
  handoffs: SyncHandoff[]
  countSamples: SyncCountSample[]
  peakWaiters: number
  inversionCount: number
  firstTs: number
  lastTs: number
  /** Mutex owner, or null when unlocked. */
  ownerId: number | null
  lockDepth: number
  holdStart: number | null
  holdInversion: boolean
  /** Owner just released — next successful lock is a handoff. */
  lastOwnerId: number | null
  /** Sem count (relative). */
  count: number
  waiters: Map<number, WaitAcc>
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function kindFromName(name: string): SyncKind | null {
  if (name.startsWith('semaphore_')) return 'sem'
  if (name.startsWith('mutex_')) return 'mutex'
  if (name.startsWith('condvar_')) return 'condvar'
  return null
}

function ensure(map: Map<number, Acc>, id: number, kind: SyncKind, ts: number): Acc {
  let a = map.get(id)
  if (!a) {
    a = {
      kind,
      marks: [],
      holdSegs: [],
      waitSegs: [],
      handoffs: [],
      countSamples: [],
      peakWaiters: 0,
      inversionCount: 0,
      firstTs: ts,
      lastTs: ts,
      ownerId: null,
      lockDepth: 0,
      holdStart: null,
      holdInversion: false,
      lastOwnerId: null,
      count: 0,
      waiters: new Map(),
    }
    map.set(id, a)
  }
  a.lastTs = ts
  return a
}

function pushMark(a: Acc, mark: SyncMark) {
  a.marks.push(mark)
  a.lastTs = mark.ts
}

function pushCount(a: Acc, ts: number) {
  const last = a.countSamples[a.countSamples.length - 1]
  if (last && last.ts === ts) {
    last.count = a.count
    return
  }
  if (last && last.count === a.count) return
  a.countSamples.push({ ts, count: a.count })
}

function noteWaiters(a: Acc) {
  a.peakWaiters = Math.max(a.peakWaiters, a.waiters.size)
}

/** Zephyr: lower numeric priority = higher urgency. */
function isHigherPrio(tr: Trace, waiterId: number, ownerId: number): boolean {
  const wp = threadPrio(tr, waiterId)
  const op = threadPrio(tr, ownerId)
  if (wp == null || op == null) return false
  return wp < op
}

function closeHold(a: Acc, ts: number) {
  if (a.ownerId == null || a.holdStart == null) return
  if (ts > a.holdStart) {
    a.holdSegs.push({
      start: a.holdStart,
      end: ts,
      ownerId: a.ownerId,
      lockDepth: Math.max(1, a.lockDepth),
      inversion: a.holdInversion,
    })
    if (a.holdInversion) a.inversionCount += 1
  }
  a.lastOwnerId = a.ownerId
  a.ownerId = null
  a.lockDepth = 0
  a.holdStart = null
  a.holdInversion = false
}

function bumpHoldDepth(a: Acc, ts: number, depth: number) {
  if (a.ownerId == null || a.holdStart == null) return
  if (ts > a.holdStart) {
    a.holdSegs.push({
      start: a.holdStart,
      end: ts,
      ownerId: a.ownerId,
      lockDepth: Math.max(1, depth),
      inversion: a.holdInversion,
    })
  }
  a.holdStart = ts
  // Keep holdInversion sticky until unlock; reentrant lock does not clear it.
}

function startWait(a: Acc, tr: Trace, tid: number, ts: number): boolean {
  if (a.waiters.has(tid)) return a.waiters.get(tid)!.inversion
  let inversion = false
  if (a.kind === 'mutex' && a.ownerId != null) {
    inversion = isHigherPrio(tr, tid, a.ownerId)
    if (inversion) a.holdInversion = true
  }
  a.waiters.set(tid, { start: ts, inversion })
  noteWaiters(a)
  return inversion
}

function endWait(a: Acc, tid: number, ts: number): WaitAcc | null {
  const w = a.waiters.get(tid)
  if (!w) return null
  a.waiters.delete(tid)
  if (ts > w.start) {
    a.waitSegs.push({
      start: w.start,
      end: ts,
      threadId: tid,
      inversion: w.inversion,
    })
  }
  return w
}

function actorAt(tr: Trace, ts: number): number | null {
  return threadRunningAt(tr, ts)
}

/**
 * Build one series per semaphore / mutex / condvar seen in the trace.
 * `nameById` is optional (ELF / object-core names keyed by address).
 */
export function reconstructSync(tr: Trace, nameById?: Map<number, string> | null): SyncSeries[] {
  const map = new Map<number, Acc>()

  for (const ev of tr.events) {
    const kind = kindFromName(ev.name)
    if (!kind) continue
    const id = numField(ev.fields.id)
    if (id == null) continue
    const a = ensure(map, id, kind, ev.ts)
    const nm = ev.name
    const tid = actorAt(tr, ev.ts)
    const ret = numField(ev.fields.ret)

    if (nm === 'semaphore_init' || nm === 'mutex_init' || nm === 'condvar_init') {
      pushMark(a, {
        ts: ev.ts,
        op: 'init',
        ok: ret == null || ret === 0,
        threadId: tid,
      })
      continue
    }

    // —— Semaphore ————————————————————————————————————————————————
    if (kind === 'sem') {
      if (nm === 'semaphore_give_exit') {
        if (a.waiters.size > 0) {
          // Highest-prio waiter is woken inside give; the token passes without
          // bumping count. Remember the giver so take_exit can draw a handoff.
          if (tid != null) a.lastOwnerId = tid
          pushMark(a, { ts: ev.ts, op: 'give', ok: true, threadId: tid, value: a.count })
        } else {
          a.count += 1
          pushCount(a, ev.ts)
          pushMark(a, { ts: ev.ts, op: 'give', ok: true, threadId: tid, value: a.count })
        }
        continue
      }
      if (nm === 'semaphore_take_blocking' && tid != null) {
        const inversion = startWait(a, tr, tid, ev.ts)
        pushMark(a, {
          ts: ev.ts,
          op: 'take',
          ok: true,
          threadId: tid,
          blocking: true,
          value: a.count,
          inversion,
        })
        continue
      }
      if (nm === 'semaphore_take_exit') {
        const ok = ret === 0
        if (tid != null) endWait(a, tid, ev.ts)
        if (ok) {
          // Non-blocking take (or woken take): consume a count when present.
          if (a.count > 0) {
            a.count -= 1
            pushCount(a, ev.ts)
          }
          if (tid != null && a.lastOwnerId != null) {
            a.handoffs.push({ ts: ev.ts, fromId: a.lastOwnerId, toId: tid })
            a.lastOwnerId = null
          }
        }
        pushMark(a, {
          ts: ev.ts,
          op: 'take',
          ok,
          threadId: tid,
          value: a.count,
        })
        continue
      }
      if (nm === 'semaphore_give_enter') {
        // Enter alone is not a state change — wait for exit.
        continue
      }
      if (nm === 'semaphore_take_enter') {
        continue
      }
      if (nm === 'semaphore_reset') {
        a.count = 0
        pushCount(a, ev.ts)
        for (const [waiterId, w] of a.waiters) {
          if (ev.ts > w.start) {
            a.waitSegs.push({
              start: w.start,
              end: ev.ts,
              threadId: waiterId,
              inversion: w.inversion,
            })
          }
        }
        a.waiters.clear()
        pushMark(a, { ts: ev.ts, op: 'reset', ok: true, threadId: tid, value: 0 })
        continue
      }
    }

    // —— Mutex ————————————————————————————————————————————————————
    if (kind === 'mutex') {
      if (nm === 'mutex_lock_blocking' && tid != null) {
        const inversion = startWait(a, tr, tid, ev.ts)
        pushMark(a, {
          ts: ev.ts,
          op: 'lock',
          ok: true,
          threadId: tid,
          blocking: true,
          ownerId: a.ownerId,
          value: a.lockDepth,
          inversion,
        })
        continue
      }
      if (nm === 'mutex_lock_exit') {
        const ok = ret === 0
        if (tid != null) endWait(a, tid, ev.ts)
        if (ok && tid != null) {
          if (a.ownerId == null) {
            // Fresh claim (possibly after unlock handoff).
            if (a.lastOwnerId != null && a.lastOwnerId !== tid) {
              a.handoffs.push({ ts: ev.ts, fromId: a.lastOwnerId, toId: tid })
            }
            a.ownerId = tid
            a.lockDepth = 1
            a.holdStart = ev.ts
            a.holdInversion = false
            // Re-check any remaining waiters (should be empty after claim).
            for (const [waiterId] of a.waiters) {
              if (isHigherPrio(tr, waiterId, tid)) a.holdInversion = true
            }
            a.lastOwnerId = null
          } else if (a.ownerId === tid) {
            bumpHoldDepth(a, ev.ts, a.lockDepth)
            a.lockDepth += 1
          } else {
            // Trace loss / missed unlock — force ownership transfer.
            closeHold(a, ev.ts)
            a.handoffs.push({ ts: ev.ts, fromId: a.lastOwnerId, toId: tid })
            a.ownerId = tid
            a.lockDepth = 1
            a.holdStart = ev.ts
            a.holdInversion = false
            a.lastOwnerId = null
          }
        }
        pushMark(a, {
          ts: ev.ts,
          op: 'lock',
          ok,
          threadId: tid,
          ownerId: a.ownerId,
          value: a.lockDepth,
        })
        continue
      }
      if (nm === 'mutex_unlock_exit') {
        const ok = ret === 0
        if (ok && a.ownerId != null) {
          if (a.lockDepth > 1) {
            bumpHoldDepth(a, ev.ts, a.lockDepth)
            a.lockDepth -= 1
          } else {
            closeHold(a, ev.ts)
          }
        }
        pushMark(a, {
          ts: ev.ts,
          op: 'unlock',
          ok,
          threadId: tid,
          ownerId: a.ownerId,
          value: a.lockDepth,
        })
        continue
      }
      if (nm === 'mutex_lock_enter' || nm === 'mutex_unlock_enter') continue
    }

    // —— Condvar ——————————————————————————————————————————————————
    if (kind === 'condvar') {
      if (nm === 'condvar_wait_enter' && tid != null) {
        // No wait_blocking event — wait_enter is the pend point.
        const inversion = startWait(a, tr, tid, ev.ts)
        pushMark(a, {
          ts: ev.ts,
          op: 'wait',
          ok: true,
          threadId: tid,
          blocking: true,
          inversion,
        })
        continue
      }
      if (nm === 'condvar_wait_exit') {
        const ok = ret === 0
        if (tid != null) endWait(a, tid, ev.ts)
        pushMark(a, { ts: ev.ts, op: 'wait', ok, threadId: tid })
        continue
      }
      if (nm === 'condvar_signal_exit') {
        pushMark(a, {
          ts: ev.ts,
          op: 'signal',
          ok: ret == null || ret === 0,
          threadId: tid,
        })
        continue
      }
      if (nm === 'condvar_broadcast_exit') {
        pushMark(a, {
          ts: ev.ts,
          op: 'broadcast',
          ok: true,
          threadId: tid,
          value: ret,
        })
        continue
      }
      if (
        nm === 'condvar_signal_enter' ||
        nm === 'condvar_signal_blocking' ||
        nm === 'condvar_broadcast_enter'
      ) {
        continue
      }
    }
  }

  const t1 = tr.t1
  const out: SyncSeries[] = []
  for (const [id, a] of map) {
    // Close open hold / waits at the live edge.
    if (a.ownerId != null && a.holdStart != null && t1 >= a.holdStart) {
      a.holdSegs.push({
        start: a.holdStart,
        end: t1,
        ownerId: a.ownerId,
        lockDepth: Math.max(1, a.lockDepth),
        inversion: a.holdInversion,
      })
      if (a.holdInversion) a.inversionCount += 1
    }
    for (const [waiterId, w] of a.waiters) {
      if (t1 > w.start) {
        a.waitSegs.push({
          start: w.start,
          end: t1,
          threadId: waiterId,
          inversion: w.inversion,
        })
      }
    }
    if (a.kind === 'sem' && a.countSamples.length === 0) {
      a.countSamples.push({ ts: a.firstTs, count: a.count })
    }
    const lastCount = a.countSamples[a.countSamples.length - 1]
    if (a.kind === 'sem' && lastCount && t1 > lastCount.ts) {
      a.countSamples.push({ ts: t1, count: a.count })
    }

    out.push({
      id,
      kind: a.kind,
      name: nameById?.get(id) ?? null,
      marks: a.marks,
      holdSegs: a.holdSegs,
      waitSegs: a.waitSegs,
      handoffs: a.handoffs,
      countSamples: a.countSamples,
      peakWaiters: a.peakWaiters,
      inversionCount: a.inversionCount,
      firstTs: a.firstTs,
      lastTs: Math.max(a.lastTs, t1),
    })
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) {
      const order = { mutex: 0, sem: 1, condvar: 2 }
      return order[a.kind] - order[b.kind]
    }
    if (a.name && b.name && a.name !== b.name) return a.name.localeCompare(b.name)
    if (a.name && !b.name) return -1
    if (!a.name && b.name) return 1
    return a.id - b.id
  })
  return out
}

export function syncKindLabel(kind: SyncKind): string {
  if (kind === 'mutex') return 'mutex'
  if (kind === 'sem') return 'sem'
  return 'condvar'
}

/** Display label: ELF / object-core name when known, else kind + hex id. */
export function syncLabel(s: SyncSeries): string {
  if (s.name) return s.name
  return `${syncKindLabel(s.kind)} 0x${s.id.toString(16)}`
}

export function syncOpLabel(op: SyncOp, blocking?: boolean): string {
  if (blocking) {
    if (op === 'lock') return 'lock (blocking)'
    if (op === 'take') return 'take (blocking)'
    if (op === 'wait') return 'wait'
  }
  return op
}

/** Count at `ts` from a step series (last sample with sample.ts <= ts). */
export function syncCountAt(samples: SyncCountSample[], ts: number): number {
  if (!samples.length || ts < samples[0]!.ts) return 0
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.ts <= ts) lo = mid + 1
    else hi = mid
  }
  return samples[lo - 1]!.count
}

export function syncWindowStats(
  series: SyncSeries[],
  view0: number,
  view1: number,
): {
  objects: number
  holds: number
  waits: number
  handoffs: number
  inversions: number
} {
  let holds = 0
  let waits = 0
  let handoffs = 0
  let inversions = 0
  let objects = 0
  for (const s of series) {
    const inView =
      s.marks.some((m) => m.ts >= view0 && m.ts <= view1) ||
      s.holdSegs.some((h) => h.end >= view0 && h.start <= view1) ||
      s.waitSegs.some((w) => w.end >= view0 && w.start <= view1)
    if (!inView && (s.firstTs > view1 || s.lastTs < view0)) continue
    if (inView || (s.firstTs <= view1 && s.lastTs >= view0)) objects += 1
    for (const h of s.holdSegs) {
      if (h.end < view0 || h.start > view1) continue
      holds += 1
      if (h.inversion) inversions += 1
    }
    for (const w of s.waitSegs) {
      if (w.end < view0 || w.start > view1) continue
      waits += 1
    }
    for (const h of s.handoffs) {
      if (h.ts < view0 || h.ts > view1) continue
      handoffs += 1
    }
  }
  return { objects, holds, waits, handoffs, inversions }
}

/** Nearest mark in a series within `maxDeltaNs` of `ts`. */
export function nearestSyncMark(
  series: SyncSeries[],
  ts: number,
  maxDeltaNs: number,
): { series: SyncSeries; mark: SyncMark } | null {
  let best: { series: SyncSeries; mark: SyncMark; d: number } | null = null
  for (const s of series) {
    for (const m of s.marks) {
      const d = Math.abs(m.ts - ts)
      if (d > maxDeltaNs) continue
      if (!best || d < best.d) best = { series: s, mark: m, d }
    }
  }
  return best ? { series: best.series, mark: best.mark } : null
}
