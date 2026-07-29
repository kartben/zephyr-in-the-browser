/**
 * Ready-queue snapshot + priority-preemption detection for the Trace Ready tab.
 *
 * Zephyr runs the highest-priority ready thread (lowest numeric `prio`).
 * This module peels that policy out of the reconstructed state machine so the
 * UI can show a live ladder instead of only a Gantt of colours.
 */

import {
  isrActiveAt,
  scheduledThreadAt,
  stateAt,
  threadLabel,
  threadPrio,
  visibleLanes,
  type Trace,
} from './reader'
import type { ThreadState } from './types'

/** A thread currently on the ready queue (`run` or `rdy`). */
export type ReadyRung = {
  tid: number
  name: string
  prio: number | null
  state: 'run' | 'rdy'
}

/** Ready queue at one guest timestamp. */
export type ReadySnapshot = {
  ts: number
  /** Highest priority first (lowest numeric prio; unknown prio last). */
  rungs: ReadyRung[]
  /** Scheduler-selected thread, even while an ISR is interrupting it. */
  runner: number | null
  isr: boolean
}

/** Context switch where the incoming thread has strictly higher priority. */
export type PriorityPreemption = {
  ts: number
  fromTid: number
  toTid: number
  fromPrio: number | null
  toPrio: number | null
}

/** Sort key: known priorities ascending, unknown last, then tid for stability. */
export function compareReadyOrder(
  a: { tid: number; prio: number | null },
  b: { tid: number; prio: number | null },
): number {
  const aKnown = a.prio != null
  const bKnown = b.prio != null
  if (aKnown && bKnown && a.prio !== b.prio) return a.prio! - b.prio!
  if (aKnown !== bKnown) return aKnown ? -1 : 1
  return a.tid - b.tid
}

/** True when `incoming` is strictly higher priority than `outgoing`. */
export function isHigherPriority(incoming: number | null, outgoing: number | null): boolean {
  if (incoming == null || outgoing == null) return false
  return incoming < outgoing
}

/**
 * Threads in `run` / `rdy` at `ts`, ordered as Zephyr's ready queue
 * (highest priority at index 0).
 */
export function readyQueueAt(tr: Trace, ts: number): ReadySnapshot {
  const rungs: ReadyRung[] = []
  for (const tid of visibleLanes(tr)) {
    const [st] = stateAt(tr, tid, ts)
    if (st !== 'run' && st !== 'rdy') continue
    rungs.push({
      tid,
      name: threadLabel(tr, tid),
      prio: threadPrio(tr, tid),
      state: st,
    })
  }
  rungs.sort(compareReadyOrder)
  return {
    ts,
    rungs,
    runner: scheduledThreadAt(tr, ts),
    isr: isrActiveAt(tr, ts),
  }
}

/**
 * Priority preemptions inside `[view0, view1]` — switches where the new
 * runner has a strictly better (lower) priority than the previous one.
 *
 * Voluntary yields to equal/lower priority threads are omitted: those teach
 * blocking/sleep, not the preemptive priority policy.
 */
export function priorityPreemptionsIn(
  tr: Trace,
  view0: number,
  view1: number,
): PriorityPreemption[] {
  const out: PriorityPreemption[] = []
  const segs = tr.segments
  if (segs.length < 2) return out

  let i = 0
  while (i < segs.length && segs[i]![1] <= view0) i++
  // Need the segment that ends at each switch; walk consecutive pairs.
  for (; i < segs.length; i++) {
    const cur = segs[i]!
    const switchTs = cur[0]
    if (switchTs > view1) break
    if (switchTs < view0) continue
    if (i === 0) continue
    const prev = segs[i - 1]!
    // Only immediate handoffs (A runs → B runs). Gaps are idle / ISR, not
    // a priority steal the ladder can attribute cleanly.
    if (prev[1] !== switchTs) continue
    const fromTid = prev[2]
    const toTid = cur[2]
    if (fromTid === toTid) continue
    const fromPrio = threadPrio(tr, fromTid)
    const toPrio = threadPrio(tr, toTid)
    if (!isHigherPriority(toPrio, fromPrio)) continue
    out.push({ ts: switchTs, fromTid, toTid, fromPrio, toPrio })
  }
  return out
}

/** Most recent priority preemption at or before `ts` inside the window. */
export function latestPriorityPreemption(
  tr: Trace,
  view0: number,
  view1: number,
  ts: number,
): PriorityPreemption | null {
  const all = priorityPreemptionsIn(tr, view0, Math.min(view1, ts))
  return all.length ? all[all.length - 1]! : null
}

/** Compact state label for ladder chrome (matches Timeline legend words). */
export function readyStateLabel(state: Extract<ThreadState, 'run' | 'rdy'>): string {
  return state === 'run' ? 'run' : 'ready'
}
