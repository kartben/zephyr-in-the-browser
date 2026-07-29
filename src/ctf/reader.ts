/**
 * Incremental Zephyr CTF stream decoder and per-thread state reconstruction.
 * Port of the non-UI half of scripts/tracing/trace_viewer.py.
 */

import {
  ISR_ENTER,
  ISR_EXIT,
  ISR_EXIT_TO_SCHEDULER,
  THREAD_INFO,
  THREAD_PRIO_SET,
  THREAD_SCHED_PRIO_SET,
  THREAD_SWITCHED_IN,
  THREAD_SWITCHED_OUT,
  type ThreadState,
} from './types'
import { decodeFields, type EventDef } from './metadata'
import {
  applyNetAddressWidth,
  needsNetAddressProbe,
  probeNetAddressWidth,
  type NetAddressWidth,
} from './netAddressWidth'

export interface CtfEvent {
  ts: number
  eid: number
  name: string
  fields: Record<string, string | number>
}

export interface ThreadInfo {
  name: string
  prio: number | null
  stackBase: number | null
  stackSize: number | null
}

/** [start, end, state, reason] */
export type StateSeg = [number, number, ThreadState, string]

export interface Trace {
  events: CtfEvent[]
  threads: Map<number, ThreadInfo>
  /** Running-thread spans: [start, end, tid] */
  segments: Array<[number, number, number]>
  isrSpans: Array<[number, number]>
  /** Start of an ISR span that has not received its outermost exit yet. */
  isrOpenStart: number | null
  states: Map<number, StateSeg[]>
  stateStarts: Map<number, number[]>
  t0: number
  t1: number
}

const SLEEP_ENTERS = new Set([
  'k_sleep_enter',
  'thread_sleep_enter',
  'thread_msleep_enter',
  'thread_usleep_enter',
])
const READY_EVENTS = new Set([
  'thread_sched_ready',
  'thread_ready',
  'thread_wakeup',
  'thread_sched_wakeup',
  'thread_resume',
  'thread_sched_resume',
])
const SUSPEND_EVENTS = new Set(['thread_suspend', 'thread_sched_suspend'])
const ABORT_EVENTS = new Set(['thread_abort', 'thread_sched_abort'])
const PEND_EVENTS = new Set(['thread_sched_pend', 'thread_pending'])

function blockReason(nm: string, f: Record<string, string | number>): string {
  if (nm.startsWith('semaphore')) return `sem 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('mutex')) return `mutex 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('msgq')) return `msgq 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('fifo')) return `fifo 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('lifo')) return `lifo 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('stack')) return `stack 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('queue')) return `queue 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('condvar')) return `condvar 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('event_wait')) return `event 0x${Number(f.event_id ?? 0).toString(16)}`
  if (nm.startsWith('thread_join')) return `join 0x${Number(f.thread_id ?? 0).toString(16)}`
  if (nm.startsWith('mem_slab')) return `memslab 0x${Number(f.id ?? 0).toString(16)}`
  if (nm.startsWith('work')) return 'work'
  return 'blocked'
}

function emptyTrace(): Trace {
  return {
    events: [],
    threads: new Map(),
    segments: [],
    isrSpans: [],
    isrOpenStart: null,
    states: new Map(),
    stateStarts: new Map(),
    t0: 0,
    t1: 0,
  }
}

export class TraceReader {
  readonly defs: Map<number, EventDef>
  readonly hasTs: boolean
  readonly tr: Trace = emptyTrace()
  desync = false
  /** Locked once the first socket address event is probed (20 if !IPv6, else 46). */
  netAddressWidth: NetAddressWidth | null = null

  private buf = new Uint8Array(0)
  private fakeTs = 0
  private prevRaw: number | null = null
  private tsOff = 0
  private curTid: number | null = null
  private segStart: number | null = null
  private isrDepth = 0
  private stCur = new Map<number, [ThreadState, number, string]>()
  private stHint = new Map<number, [ThreadState, string]>()
  private running: number | null = null
  private provisional: number[] = []

  constructor(defs: Map<number, EventDef>, hasTs = true) {
    this.defs = defs
    this.hasTs = hasTs
  }

  private thread(tid: number): ThreadInfo {
    let t = this.tr.threads.get(tid)
    if (!t) {
      t = { name: '', prio: null, stackBase: null, stackSize: null }
      this.tr.threads.set(tid, t)
    }
    return t
  }

  private stClose(tid: number, ts: number) {
    const st = this.stCur.get(tid)
    if (st && ts > st[1]) {
      const segs = this.tr.states.get(tid) ?? []
      segs.push([st[1], ts, st[0], st[2]])
      this.tr.states.set(tid, segs)
      const starts = this.tr.stateStarts.get(tid) ?? []
      starts.push(st[1])
      this.tr.stateStarts.set(tid, starts)
    }
  }

  private stSet(tid: number, ts: number, state: ThreadState, reason = '') {
    this.stClose(tid, ts)
    this.stCur.set(tid, [state, ts, reason])
  }

  private closeIsrSpan(ts: number) {
    const start = this.tr.isrOpenStart
    if (start !== null && ts > start) this.tr.isrSpans.push([start, ts])
    this.tr.isrOpenStart = null
    this.isrDepth = 0
  }

  private dropProvisional() {
    for (const tid of this.provisional) {
      this.tr.states.get(tid)?.pop()
      this.tr.stateStarts.get(tid)?.pop()
    }
    this.provisional = []
  }

  private addProvisional() {
    const last = this.tr.t1
    for (const [tid, st] of this.stCur) {
      const [state, since, reason] = st
      // Include since == last so a switch on the final event is visible to
      // stateAt/threadRunningAt (open-ended last segment). `last > since`
      // left that run only in stCur and let the previous closed segment
      // falsely extend forever — under async CTF that pinned edges on main.
      if (last >= since && state !== 'dead') {
        const segs = this.tr.states.get(tid) ?? []
        segs.push([since, last, state, reason])
        this.tr.states.set(tid, segs)
        const starts = this.tr.stateStarts.get(tid) ?? []
        starts.push(since)
        this.tr.stateStarts.set(tid, starts)
        this.provisional.push(tid)
      }
    }
  }

  private stateMachine(ts: number, nm: string, fields: Record<string, string | number>, tid: number | null) {
    if (nm === 'thread_switched_in') {
      // Async CTF / lost events can skip switched_out. Demote the previous
      // runner so we never leave two threads marked `run` (threadRunningAt
      // used to return Map-insertion order — usually `main`).
      if (this.running !== null && this.running !== tid) {
        const prev = this.running
        if (this.stCur.get(prev)?.[0] === 'run') {
          const h = this.stHint.get(prev)
          if (h) this.stSet(prev, ts, h[0], h[1])
          else this.stSet(prev, ts, 'rdy')
          this.stHint.delete(prev)
        }
      }
      this.running = tid
      if (tid !== null) {
        this.stSet(tid, ts, 'run')
        this.stHint.delete(tid)
      }
    } else if (nm === 'thread_switched_out') {
      const t = tid ?? this.running
      if (t !== null && this.stCur.get(t)?.[0] === 'run') {
        const h = this.stHint.get(t)
        if (h) this.stSet(t, ts, h[0], h[1])
        else this.stSet(t, ts, 'rdy')
        this.stHint.delete(t)
      }
      this.running = null
    } else if (SLEEP_ENTERS.has(nm)) {
      if (this.running !== null) {
        const to = fields.timeout ?? fields.ms ?? fields.us ?? ''
        this.stHint.set(this.running, ['slp', `sleep ${to}`])
      }
    } else if (nm.endsWith('_blocking')) {
      if (this.running !== null) {
        this.stHint.set(this.running, ['blk', blockReason(nm, fields)])
      }
    } else if (PEND_EVENTS.has(nm)) {
      if (tid !== null) {
        const h = this.stHint.get(tid)
        this.stSet(tid, ts, 'blk', h?.[1] ?? 'blocked')
      }
    } else if (READY_EVENTS.has(nm)) {
      if (tid !== null) {
        this.stSet(tid, ts, 'rdy')
        this.stHint.delete(tid)
      }
    } else if (SUSPEND_EVENTS.has(nm)) {
      if (tid !== null) this.stSet(tid, ts, 'sus')
    } else if (ABORT_EVENTS.has(nm)) {
      if (tid !== null) this.stSet(tid, ts, 'dead')
    } else if (nm === 'thread_create') {
      if (tid !== null && !this.stCur.has(tid)) this.stSet(tid, ts, 'rdy')
    }
  }

  private consume(ts: number, eid: number, name: string, fields: Record<string, string | number>) {
    const tr = this.tr
    tr.events.push({ ts, eid, name, fields })
    if (tr.events.length === 1) tr.t0 = ts
    tr.t1 = ts

    const tidRaw = fields.thread_id
    const tid = typeof tidRaw === 'number' ? tidRaw : null
    if (tid !== null) {
      const t = this.thread(tid)
      const nm = fields.name
      if (typeof nm === 'string' && nm) t.name = nm
      if ((eid === THREAD_PRIO_SET || eid === THREAD_SCHED_PRIO_SET) && typeof fields.prio === 'number') {
        t.prio = fields.prio
      }
      if (eid === THREAD_INFO) {
        if (typeof fields.stack_base === 'number') t.stackBase = fields.stack_base
        if (typeof fields.stack_size === 'number') t.stackSize = fields.stack_size
      }
    }

    if (
      (eid === THREAD_SWITCHED_IN || eid === THREAD_SWITCHED_OUT) &&
      this.isrDepth > 0
    ) {
      // A context switch cannot complete inside the outer ISR. If async CTF
      // dropped its exit record, use the next switch as the conservative end
      // rather than masking every subsequent actor as ISR-originated.
      this.closeIsrSpan(ts)
    }

    if (eid === THREAD_SWITCHED_IN) {
      if (this.curTid !== null && this.segStart !== null) {
        tr.segments.push([this.segStart, ts, this.curTid])
      }
      this.curTid = tid
      this.segStart = ts
    } else if (eid === THREAD_SWITCHED_OUT) {
      if (this.curTid !== null && this.segStart !== null) {
        tr.segments.push([this.segStart, ts, this.curTid])
      }
      this.curTid = null
      this.segStart = null
    }

    if (eid === ISR_ENTER) {
      if (this.isrDepth === 0) tr.isrOpenStart = ts
      this.isrDepth++
    } else if (eid === ISR_EXIT || eid === ISR_EXIT_TO_SCHEDULER) {
      if (this.isrDepth > 0) {
        this.isrDepth--
        if (this.isrDepth === 0) this.closeIsrSpan(ts)
      }
    }

    this.stateMachine(ts, name, fields, tid)
  }

  private decodeBuf(): number {
    const data = this.buf
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const hsz = this.hasTs ? 10 : 2
    let off = 0
    let neu = 0
    const n = data.length

    while (off + hsz <= n) {
      let ts: number
      let eid: number
      if (this.hasTs) {
        const raw = Number(view.getBigUint64(off, true))
        eid = view.getUint16(off + 8, true)
        if (this.prevRaw !== null && raw < this.prevRaw) this.tsOff += this.prevRaw
        this.prevRaw = raw
        ts = raw + this.tsOff
      } else {
        eid = view.getUint16(off, true)
        ts = this.fakeTs++
      }
      let edef = this.defs.get(eid)
      if (!edef) {
        this.desync = true
        break
      }

      // Zephyr TSDL says address[46], but !NET_IPV6 guests emit 20-byte strings.
      if (this.netAddressWidth == null && needsNetAddressProbe(edef)) {
        const bodyOff = off + hsz
        const bodyAvail = n - bodyOff
        const probed = probeNetAddressWidth(this.defs, edef, bodyOff, bodyAvail, (nextOff) => {
          if (nextOff + hsz > n) return null
          return this.hasTs ? view.getUint16(nextOff + 8, true) : view.getUint16(nextOff, true)
        })
        if (probed.kind === 'wait') break
        if (probed.kind === 'desync') {
          this.desync = true
          break
        }
        this.netAddressWidth = probed.width
        applyNetAddressWidth(this.defs, probed.width)
        edef = this.defs.get(eid) ?? probed.def
      }

      const rec = hsz + edef.size
      if (off + rec > n) break
      const { fields } = decodeFields(edef, data, off + hsz, view)
      off += rec
      this.consume(ts, eid, edef.name, fields)
      neu++
    }
    this.buf = data.subarray(off)
    return neu
  }

  /** Append bytes; decode every complete record. Returns new event count. */
  feed(chunk: Uint8Array): number {
    if (chunk.length === 0) return 0
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged
    this.dropProvisional()
    const neu = this.decodeBuf()
    this.addProvisional()
    return neu
  }
}

/**
 * Thread ids for Gantt lanes: Zephyr priority ascending (lower = higher
 * priority; negative = cooperative), unknown prio last. Ties break by
 * thread id only — never by busy time, so live follow does not reshuffle.
 */
export function laneOrder(tr: Trace): number[] {
  return [...tr.threads.keys()].sort((a, b) => {
    const pa = tr.threads.get(a)?.prio
    const pb = tr.threads.get(b)?.prio
    const aKnown = pa != null
    const bKnown = pb != null
    if (aKnown && bKnown && pa !== pb) return pa - pb
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    return a - b
  })
}

/** Lanes worth painting: non-dead state somewhere in the trace. */
export function visibleLanes(tr: Trace): number[] {
  return laneOrder(tr).filter((tid) => {
    const segs = tr.states.get(tid)
    return segs != null && segs.some(([, , st]) => st !== 'dead')
  })
}

export function threadLabel(tr: Trace, tid: number): string {
  return tr.threads.get(tid)?.name || '(unnamed)'
}

/** Scheduler priority from CTF, or null when never reported. */
export function threadPrio(tr: Trace, tid: number): number | null {
  return tr.threads.get(tid)?.prio ?? null
}

export function fmtTime(ns: number): string {
  const abs = Math.abs(ns)
  if (abs >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(3)}s`
  if (abs >= 1_000_000) return `${(ns / 1_000_000).toFixed(3)}ms`
  if (abs >= 1_000) return `${(ns / 1_000).toFixed(3)}µs`
  return `${Math.round(ns)}ns`
}

/**
 * Axis / hover label for a relative timestamp. Unit follows `stepNs` so adjacent
 * ticks stay distinguishable; past 1s the label switches to seconds so zoomed
 * windows don't read as `5776.375ms`.
 */
export function fmtAxisTime(relNs: number, stepNs: number): string {
  const step = Math.max(1, Math.abs(stepNs))
  const abs = Math.abs(relNs)
  if (abs >= 1_000_000_000 || step >= 100_000_000) {
    const decimals = step >= 1_000_000 ? 3 : step >= 100_000 ? 4 : 6
    return `${(relNs / 1_000_000_000).toFixed(decimals)}s`
  }
  if (step >= 100_000) return `${(relNs / 1_000_000).toFixed(3)}ms`
  if (step >= 100) return `${(relNs / 1_000).toFixed(3)}µs`
  return `${Math.round(relNs)}ns`
}

/**
 * Nice tick spacing for a time-axis spanning `spanNs`, aiming for ~target ticks.
 * Returns a step in nanoseconds from a 1/2/5×10^n ladder.
 */
export function niceTimeStep(spanNs: number, targetTicks = 5): number {
  const span = Math.max(1, spanNs)
  const raw = span / Math.max(2, targetTicks)
  const exp = Math.floor(Math.log10(raw))
  const mag = 10 ** exp
  const norm = raw / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}

/** Major tick timestamps for [view0, view1], inclusive of edges when they land on-step. */
export function timeTickValues(
  view0: number,
  view1: number,
  targetTicks = 5,
): { values: number[]; step: number } {
  const span = Math.max(1, view1 - view0)
  const step = niceTimeStep(span, targetTicks)
  const values: number[] = []
  const first = Math.ceil(view0 / step) * step
  for (let t = first; t <= view1 + step * 0.01; t += step) values.push(t)
  return { values, step }
}

/**
 * Dominant state per column for each lane over [view0, view1].
 * `null` means the lane had no state covering that column.
 */
export function renderStateRows(
  tr: Trace,
  lanes: number[],
  view0: number,
  view1: number,
  width: number,
): Map<number, Array<ThreadState | null>> {
  const span = Math.max(1, view1 - view0)
  const colNs = span / width
  const out = new Map<number, Array<ThreadState | null>>()

  for (const tid of lanes) {
    const cells: Array<ThreadState | null> = Array.from({ length: width }, () => null)
    const segs = tr.states.get(tid)
    const starts = tr.stateStarts.get(tid)
    if (segs && starts && starts.length) {
      const acc = new Map<number, Map<ThreadState, number>>()
      let i = bisectRight(starts, view0) - 1
      if (i < 0) i = 0
      while (i < segs.length) {
        const [s, e, state] = segs[i]!
        i++
        if (s >= view1) break
        if (e <= view0 || state === 'dead') continue
        const cs = Math.max(s, view0)
        const ce = Math.min(e, view1)
        const c0 = (cs - view0) / colNs
        const c1 = (ce - view0) / colNs
        const i0 = Math.floor(c0)
        const i1 = Math.min(width - 1, Math.floor(c1))
        for (let c = i0; c <= i1; c++) {
          const cov = Math.min(c + 1, c1) - Math.max(c, c0)
          if (cov <= 0) continue
          let d = acc.get(c)
          if (!d) {
            d = new Map()
            acc.set(c, d)
          }
          d.set(state, (d.get(state) ?? 0) + cov)
        }
      }
      for (const [c, d] of acc) {
        let best: ThreadState | null = null
        let bestv = -1
        for (const [st, v] of d) {
          if (
            v > bestv ||
            (v === bestv &&
              (best === null || STATE_PREC_LOCAL[st] > STATE_PREC_LOCAL[best]))
          ) {
            best = st
            bestv = v
          }
        }
        cells[c] = best
      }
    }
    out.set(tid, cells)
  }
  return out
}

/**
 * Visit clipped state segments in [view0, view1] in timestamp order.
 * Prefer this over {@link renderStateRows} when marks must share the same
 * ns→x map (queue edges, playhead) — column rasterisation smears transitions
 * left of their true start by up to one column.
 */
export function forEachStateInView(
  tr: Trace,
  tid: number,
  view0: number,
  view1: number,
  visit: (s: number, e: number, state: ThreadState) => void,
): void {
  const segs = tr.states.get(tid)
  const starts = tr.stateStarts.get(tid)
  if (!segs || !starts?.length) return
  let i = bisectRight(starts, view0) - 1
  if (i < 0) i = 0
  while (i < segs.length) {
    const [s, e, state] = segs[i]!
    i++
    if (s >= view1) break
    if (e <= view0 || state === 'dead') continue
    visit(Math.max(s, view0), Math.min(e, view1), state)
  }
}

const STATE_PREC_LOCAL: Record<ThreadState, number> = {
  run: 5,
  blk: 4,
  rdy: 3,
  slp: 2,
  sus: 1,
  dead: 0,
}

function bisectRight(arr: number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < arr[mid]!) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** State of thread tid at time ts. */
export function stateAt(tr: Trace, tid: number, ts: number): [ThreadState | null, string] {
  const starts = tr.stateStarts.get(tid)
  const segs = tr.states.get(tid)
  if (!starts || !segs || !starts.length) return [null, '']
  const i = bisectRight(starts, ts) - 1
  if (i < 0) return [null, '']
  const [s, e, state, reason] = segs[i]!
  if (s <= ts && (ts < e || i === starts.length - 1)) return [state, reason]
  return [null, '']
}

/** Whether `ts` falls inside a closed or currently-open ISR span. */
export function isrActiveAt(tr: Trace, ts: number): boolean {
  const spans = tr.isrSpans
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]![1] <= ts) lo = mid + 1
    else hi = mid
  }
  if (lo < spans.length) {
    const [s, e] = spans[lo]!
    if (s <= ts && ts < e) return true
  }
  return tr.isrOpenStart !== null && tr.isrOpenStart <= ts
}

/** Running thread at ts (single-CPU), or null when unknown / in an ISR. */
export function threadRunningAt(tr: Trace, ts: number): number | null {
  // The interrupted thread remains the scheduler's current thread throughout
  // an ISR. Mask it here so ISR-originated kernel operations are not falsely
  // attributed to that thread.
  if (isrActiveAt(tr, ts)) return null

  // Prefer closed schedule segments — they survive a missing switched_out in
  // the per-thread state machine (common under async CTF drop).
  const segs = tr.segments
  let lo = 0
  let hi = segs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const [s, e] = segs[mid]!
    if (e <= ts) lo = mid + 1
    else if (s > ts) hi = mid
    else return segs[mid]![2]
  }

  // Open tail (last switched_in not yet closed) or duplicate `run` rows: pick
  // the run segment with the latest start, never Map insertion order (`main`).
  let best: number | null = null
  let bestSince = -Infinity
  for (const tid of tr.threads.keys()) {
    const starts = tr.stateStarts.get(tid)
    const states = tr.states.get(tid)
    if (!starts?.length || !states?.length) continue
    const i = bisectRight(starts, ts) - 1
    if (i < 0) continue
    const [s, e, state] = states[i]!
    if (state !== 'run') continue
    if (!(s <= ts && (ts < e || i === starts.length - 1))) continue
    if (s >= bestSince) {
      bestSince = s
      best = tid
    }
  }
  return best
}

/**
 * Per-thread time in each state over [view0, view1], mirroring
 * scripts/tracing/trace_viewer.py::window_stats.
 */
export function windowStats(
  tr: Trace,
  view0: number,
  view1: number,
): { per: Map<number, Partial<Record<ThreadState, number>>>; spanNs: number } {
  const spanNs = Math.max(1, view1 - view0)
  const per = new Map<number, Partial<Record<ThreadState, number>>>()
  for (const [tid, segs] of tr.states) {
    const starts = tr.stateStarts.get(tid)
    if (!starts?.length) continue
    let i = Math.max(0, bisectRight(starts, view0) - 1)
    const acc: Partial<Record<ThreadState, number>> = {}
    while (i < segs.length) {
      const [s, e, st] = segs[i]!
      i++
      if (s >= view1) break
      if (e <= view0) continue
      const d = Math.min(e, view1) - Math.max(s, view0)
      if (d > 0) acc[st] = (acc[st] ?? 0) + d
    }
    if (Object.keys(acc).length) per.set(tid, acc)
  }
  return { per, spanNs }
}

/** Count THREAD_SWITCHED_IN events in [view0, view1]. */
export function contextSwitchesIn(tr: Trace, view0: number, view1: number): number {
  // Events are appended in timestamp order — skip the prefix with a bisect
  // rather than scanning every retained event on each paint.
  const events = tr.events
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid]!.ts < view0) lo = mid + 1
    else hi = mid
  }
  let n = 0
  for (let i = lo; i < events.length; i++) {
    const ev = events[i]!
    if (ev.ts > view1) break
    if (ev.eid === 0x11) n++
  }
  return n
}
