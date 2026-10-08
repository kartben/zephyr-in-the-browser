/**
 * Incremental Zephyr CTF stream decoder and per-thread state reconstruction.
 * Port of the non-UI half of scripts/tracing/trace_viewer.py.
 */

import {
  ISR_ENTER,
  ISR_EXIT,
  ISR_EXIT_TO_SCHEDULER,
  PM_STATE_SET_ENTER,
  STATE_LABEL,
  THREAD_INFO,
  THREAD_PRIO_SET,
  THREAD_SCHED_PRIO_SET,
  THREAD_SWITCHED_IN,
  THREAD_SWITCHED_OUT,
  type ThreadState,
} from './types'
import { decodeFields, type EventDef } from './metadata'
import { CpuPowerTracker, emptyCpuPower, type CpuPowerTimelines } from './cpuPower'
import {
  applyNetAddressWidth,
  hasNetAddressField,
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

/**
 * [start, end, state, reason, object]. The reason is a sleep's timeout, or the
 * kind of kernel object a blocked thread waits on ('mutex', 'condvar', …), and
 * the object is that one's address, when the trace gives it. CTF carries no
 * names: {@link describeState} takes them from the caller.
 */
export type StateSeg = [number, number, ThreadState, string, number | null]

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
  /** CPU power states, empty unless the guest has CONFIG_PM. See cpuPower.ts. */
  cpuPower: CpuPowerTimelines
  t0: number
  t1: number
}

const SLEEP_ENTERS = new Set([
  // The only sleep hook Zephyr main has left: k_sleep(), k_msleep() and
  // k_usleep() are inline wrappers around k_sleep_ticks() now. The rest are what
  // older guests emit.
  'thread_sleep_ticks_enter',
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
/** Logged between a `mutex_lock_blocking` and its pend: the priority lent to the owner. */
const PRIO_EVENTS = new Set(['thread_priority_set', 'thread_sched_priority_set'])

/**
 * What each `*_blocking` event waits on, by name prefix: the kind of object and
 * the field holding its address. `work_queue_` must come before `work_`.
 */
const WAIT_TARGETS: Array<[prefix: string, kind: string, field: string]> = [
  ['semaphore_', 'sem', 'id'],
  ['mutex_', 'mutex', 'id'],
  ['condvar_', 'condvar', 'id'],
  ['msgq_', 'msgq', 'id'],
  ['queue_', 'queue', 'id'],
  ['fifo_', 'fifo', 'id'],
  ['lifo_', 'lifo', 'id'],
  ['stack_', 'stack', 'id'],
  ['mem_slab_', 'memslab', 'id'],
  ['heap_', 'heap', 'id'],
  ['pipe_', 'pipe', 'id'],
  ['mbox_', 'mbox', 'mbox_id'],
  ['event_', 'event', 'event_id'],
  ['timer_', 'timer', 'id'],
  ['thread_join_', 'join', 'thread_id'],
  ['work_queue_', 'work queue', 'queue_id'],
  ['work_', 'work', 'work_id'],
]

interface WaitTarget {
  kind: string
  object: number | null
}

/** The object a `*_blocking` event says its thread waits on. */
function waitTarget(nm: string, f: Record<string, string | number>): WaitTarget {
  for (const [prefix, kind, field] of WAIT_TARGETS) {
    if (!nm.startsWith(prefix)) continue
    const object = f[field]
    return { kind, object: typeof object === 'number' ? object : null }
  }
  return { kind: '', object: null }
}

/**
 * A state as the Timeline says it: "blocked on mutex bus_mutex", "sleep 25",
 * "ready". `nameOf` names a waited-on object from its kind and address; one it
 * cannot name shows its address.
 */
export function describeState(
  state: ThreadState,
  reason: string,
  object: number | null,
  nameOf: (kind: string, address: number) => string | undefined = () => undefined,
): string {
  if (state === 'blk' && reason) {
    if (object === null) return `blocked on ${reason}`
    return `blocked on ${reason} ${nameOf(reason, object) || `0x${object.toString(16)}`}`
  }
  if (state === 'slp' && reason) return reason
  return STATE_LABEL[state]
}

/**
 * Zephyr's CTF header timestamp is `timing_ns_get()` — nanoseconds since boot.
 * Three years of uptime is already absurd for a board on a desk; anything past
 * it is payload bytes being read as a header, not a clock. ASCII thread names
 * land around 7e18, so this separates the two by two orders of magnitude.
 */
const MAX_TS_NS = 1e17
/**
 * Consecutive CTF records further apart than this are not consecutive records.
 * Only gates sync acquisition — a tracing Zephyr emits scheduler events far
 * more often, even idle, so the bound stays loose enough for a quiet board.
 */
const MAX_GAP_NS = 300e9
/** Headers that must line up before an arbitrary byte is trusted as a boundary. */
const SYNC_RECORDS = 3
/**
 * A backward step smaller than this is jitter to ride out, not a counter
 * restart. Bigger ones have to be re-proven by the chain validator.
 */
const WRAP_MIN_DROP_NS = 1e9

type SyncVerdict = 'yes' | 'no' | 'wait'

function emptyTrace(): Trace {
  return {
    events: [],
    threads: new Map(),
    segments: [],
    isrSpans: [],
    isrOpenStart: null,
    states: new Map(),
    stateStarts: new Map(),
    cpuPower: emptyCpuPower(),
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
  /** Stream offset of `buf[0]`: every byte before it has been decoded or skipped. */
  private base = 0
  /**
   * Called after each record with the stream offset just past it, for an index
   * from timestamps to bytes (see tracePlayback.ts). Offsets count from this
   * reader's first fed byte.
   */
  onRecord: ((end: number, ts: number) => void) | null = null
  /** A fork keeps its origin as t0, rather than taking the first event's. */
  private anchored = false
  /** Timestamp of the newest record decoded, or of the fork point before one. */
  private newest = 0
  private fakeTs = 0
  private prevRaw: number | null = null
  private tsOff = 0
  /** False while hunting for a record boundary; see validateChain(). */
  private synced: boolean
  private curTid: number | null = null
  private segStart: number | null = null
  private isrDepth = 0
  private stCur = new Map<number, [ThreadState, number, string, number | null]>()
  private stHint = new Map<number, [ThreadState, string, number | null]>()
  /** What the running thread just said it will wait on, for the pend that follows. */
  private nextWait: (WaitTarget & { tid: number }) | null = null
  /** The condvar each thread waits on, from its `condvar_wait_enter` to its `condvar_wait_exit`. */
  private condvarWaits = new Map<number, number>()
  private running: number | null = null
  private provisional: number[] = []
  private pm = new CpuPowerTracker(this.tr.cpuPower)
  /**
   * Whether the guest emits the pair the CPU power band is built on. Zephyr main
   * traces only `pm_system_suspend_*`, whose exit reports ACTIVE for every
   * successful suspend, so on its own it would record each one as the policy
   * declining. Such a guest gets no power data rather than wrong data.
   */
  private readonly power: boolean
  /**
   * Whether the guest has logged a pend, as Zephyr does since 4.3. From then
   * on a thread is blocked once it pends, and a `*_blocking` event only says on
   * what. Not every one comes from a thread about to wait: k_condvar_signal()
   * logs `condvar_signal_blocking` in the thread that signals,
   * k_queue_insert() logs `queue_queue_insert_blocking` in the one that hands
   * its item to a waiting getter, and k_msgq_get() logs `msgq_get_blocking`
   * when it makes room for a waiting writer as well as when it waits itself.
   * Each goes on running.
   *
   * An older guest logs no pend, and none of those events either. There a
   * thread that logged `*_blocking` and then switched out blocked. Its table
   * can be today's, whose scheduler and sync ids have not moved, so this is
   * learned from the stream rather than from the table.
   */
  private pends = false

  /**
   * @param live - the byte source can start mid-record (desktop bridge, probe).
   *   A file written from byte 0 is aligned by construction and starts synced.
   */
  constructor(defs: Map<number, EventDef>, hasTs = true, live = false) {
    this.defs = defs
    this.hasTs = hasTs
    this.synced = !live || !hasTs
    this.power = [...defs.values()].some((def) => def.name === PM_STATE_SET_ENTER)
  }

  /**
   * Does `off` look like a real record boundary?
   *
   * A known event id alone is a weak test: Zephyr's TSDL packs 300+ ids into
   * 0x10..0x1xx, so zero padding and ASCII thread names hit one regularly. Once
   * such a byte is accepted the *payload* is read as the 64-bit timestamp,
   * which is where ~7e18 ns ("245 years") timelines come from — and because a
   * backward step then looks like a counter restart, the bogus epoch is added
   * to every timestamp that follows. So walk several headers forward and
   * require each to be a known id at a plausible, non-decreasing time.
   */
  private validateChain(view: DataView, n: number, hsz: number, off: number): SyncVerdict {
    if (off + hsz > n) return 'wait'
    // Carrying on forward from a timestamp we already trust adds a check, not a
    // shortcut: every header still has to line up. One is not enough. Inside a
    // record the reader cannot size (an event newer than its metadata), a known
    // id at a later time turns up regularly: seven bytes into a 10 ms
    // `thread_sleep_ticks_enter`, the next header's timestamp supplies the id
    // and the sleep argument reads as 167.77 s. Accepted, that record makes the
    // real ones after it look like a counter restart, and the restart epoch
    // keeps the bogus time in every later timestamp.
    const anchored = this.prevRaw !== null && Number(view.getBigUint64(off, true)) >= this.prevRaw
    let prev: number | null = anchored ? this.prevRaw : null
    let cur = off
    for (let i = 0; i < SYNC_RECORDS; i++) {
      if (cur + hsz > n) return 'wait'
      const def = this.defs.get(view.getUint16(cur + 8, true))
      if (!def) return 'no'
      const raw = Number(view.getBigUint64(cur, true))
      if (!Number.isFinite(raw) || raw < 0 || raw > MAX_TS_NS) return 'no'
      if (prev !== null && (raw < prev || raw - prev > MAX_GAP_NS)) return 'no'
      prev = raw
      // An unprobed net-address event has no settled size yet, so the next
      // header is not where we could compute it. Stop rather than guess: after
      // an agreeing header that is a boundary, but as the first header it proves
      // nothing, and more bytes would not change that, so waiting would stall
      // the reader at this offset for good.
      if (this.netAddressWidth == null && hasNetAddressField(def)) return i >= 1 ? 'yes' : 'no'
      cur += hsz + def.size
    }
    return 'yes'
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
      segs.push([st[1], ts, st[0], st[2], st[3]])
      this.tr.states.set(tid, segs)
      const starts = this.tr.stateStarts.get(tid) ?? []
      starts.push(st[1])
      this.tr.stateStarts.set(tid, starts)
    }
  }

  private stSet(tid: number, ts: number, state: ThreadState, reason = '', object: number | null = null) {
    this.stClose(tid, ts)
    this.stCur.set(tid, [state, ts, reason, object])
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
      const [state, since, reason, object] = st
      // Include since == last so a switch on the final event is visible to
      // stateAt/threadRunningAt (open-ended last segment). `last > since`
      // left that run only in stCur and let the previous closed segment
      // falsely extend forever — under async CTF that pinned edges on main.
      if (last >= since && state !== 'dead') {
        const segs = this.tr.states.get(tid) ?? []
        segs.push([since, last, state, reason, object])
        this.tr.states.set(tid, segs)
        const starts = this.tr.stateStarts.get(tid) ?? []
        starts.push(since)
        this.tr.stateStarts.set(tid, starts)
        this.provisional.push(tid)
      }
    }
  }

  private stateMachine(ts: number, nm: string, fields: Record<string, string | number>, tid: number | null) {
    // A `*_blocking` event names the wait of the pend that comes right after
    // it, with nothing in between but the priority a mutex lends its owner.
    // Anything else means the thread went on running.
    const wait = this.nextWait
    if (!PRIO_EVENTS.has(nm)) this.nextWait = null

    if (nm === 'thread_switched_in') {
      // Async CTF / lost events can skip switched_out. Demote the previous
      // runner so we never leave two threads marked `run` (threadRunningAt
      // used to return Map-insertion order — usually `main`).
      if (this.running !== null && this.running !== tid) {
        const prev = this.running
        if (this.stCur.get(prev)?.[0] === 'run') {
          const h = this.stHint.get(prev)
          if (h) this.stSet(prev, ts, h[0], h[1], h[2])
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
        if (h) this.stSet(t, ts, h[0], h[1], h[2])
        else this.stSet(t, ts, 'rdy')
        this.stHint.delete(t)
      }
      this.running = null
    } else if (SLEEP_ENTERS.has(nm)) {
      if (this.running !== null) {
        const to = fields.timeout ?? fields.ms ?? fields.us ?? ''
        this.stHint.set(this.running, ['slp', `sleep ${to}`, null])
      }
    } else if (nm === 'condvar_wait_enter') {
      // A condvar wait logs no `*_blocking`, so its pend learns the condvar here.
      if (this.running !== null && typeof fields.id === 'number') {
        this.condvarWaits.set(this.running, fields.id)
      }
    } else if (nm === 'condvar_wait_exit') {
      if (this.running !== null) this.condvarWaits.delete(this.running)
    } else if (nm.endsWith('_blocking')) {
      if (this.running !== null) {
        const target = waitTarget(nm, fields)
        const cur = this.stCur.get(this.running)
        if (!this.pends) this.stHint.set(this.running, ['blk', target.kind, target.object])
        else if (cur?.[0] === 'blk') {
          // k_thread_join() pends first, and only then says on whom.
          cur[2] = target.kind
          cur[3] = target.object
        } else this.nextWait = { tid: this.running, ...target }
      }
    } else if (PEND_EVENTS.has(nm)) {
      this.pends = true
      if (tid !== null) {
        const h = this.stHint.get(tid)
        const cv = this.condvarWaits.get(tid)
        const on: WaitTarget | null =
          wait?.tid === tid
            ? wait
            : h?.[0] === 'blk'
              ? { kind: h[1], object: h[2] }
              : cv !== undefined
                ? { kind: 'condvar', object: cv }
                : null
        this.stSet(tid, ts, 'blk', on?.kind ?? '', on?.object ?? null)
      }
    } else if (READY_EVENTS.has(nm)) {
      if (tid !== null) {
        this.stSet(tid, ts, 'rdy')
        this.stHint.delete(tid)
      }
    } else if (SUSPEND_EVENTS.has(nm)) {
      if (tid !== null) this.stSet(tid, ts, 'sus')
    } else if (ABORT_EVENTS.has(nm)) {
      if (tid !== null) {
        this.stSet(tid, ts, 'dead')
        this.condvarWaits.delete(tid)
      }
    } else if (nm === 'thread_create') {
      if (tid !== null && !this.stCur.has(tid)) this.stSet(tid, ts, 'rdy')
    }
  }

  private consume(ts: number, eid: number, name: string, fields: Record<string, string | number>) {
    const tr = this.tr
    tr.events.push({ ts, eid, name, fields })
    if (tr.events.length === 1 && !this.anchored) tr.t0 = ts
    tr.t1 = ts
    this.newest = ts

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

    if (this.power) this.pm.event(ts, name, fields)

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
      // Peek the id only — a live source (desktop bridge) can attach mid-stream,
      // landing anywhere inside a record. An unknown id means this byte is not a
      // record boundary, not that the stream is unrecoverable: slide forward one
      // byte at a time until a known id lines up again instead of wedging on the
      // first misaligned header forever.
      const eid = this.hasTs ? view.getUint16(off + 8, true) : view.getUint16(off, true)
      let edef = this.defs.get(eid)
      if (!edef) {
        this.desync = true
        this.synced = false
        off += 1
        continue
      }

      // Landing byte-aligned on a known id is not proof of a boundary — make
      // the following headers agree before trusting this one.
      let justValidated = false
      if (this.hasTs && !this.synced) {
        const verdict = this.validateChain(view, n, hsz, off)
        if (verdict === 'wait') break
        if (verdict === 'no') {
          this.desync = true
          off += 1
          continue
        }
        this.synced = true
        justValidated = true
      }

      // Zephyr TSDL says address[46], but !NET_IPV6 guests emit 20-byte strings.
      if (this.netAddressWidth == null && hasNetAddressField(edef)) {
        const bodyOff = off + hsz
        const bodyAvail = n - bodyOff
        const probed = probeNetAddressWidth(this.defs, edef, bodyOff, bodyAvail, (nextOff) => {
          if (nextOff + hsz > n) return null
          return this.hasTs ? view.getUint16(nextOff + 8, true) : view.getUint16(nextOff, true)
        })
        if (probed.kind === 'wait') break
        if (probed.kind === 'desync') {
          this.desync = true
          this.synced = false
          off += 1
          continue
        }
        this.netAddressWidth = probed.width
        applyNetAddressWidth(this.defs, probed.width)
        edef = this.defs.get(eid) ?? probed.def
      }

      const rec = hsz + edef.size
      if (off + rec > n) break

      let ts: number
      if (this.hasTs) {
        const raw = Number(view.getBigUint64(off, true))
        if (!Number.isFinite(raw) || raw < 0 || raw > MAX_TS_NS) {
          // Not a clock — so `off` was never a boundary. Hunt for the next one
          // instead of letting the value reach t0/t1.
          this.desync = true
          this.synced = false
          off += 1
          continue
        }
        if (this.prevRaw !== null && raw < this.prevRaw) {
          const drop = this.prevRaw - raw
          if (drop >= WRAP_MIN_DROP_NS && !justValidated) {
            // Zephyr's timestamp restarts when the target's cycle counter is
            // 32-bit, but a false boundary looks identical from here — and
            // guessing "restart" adds a permanent epoch to the timeline. Make
            // the chain validator rule on this same offset first.
            this.synced = false
            continue
          }
          if (drop >= WRAP_MIN_DROP_NS) this.tsOff += this.prevRaw
          // Smaller steps are jitter: keep the current epoch.
        }
        this.prevRaw = raw
        ts = raw + this.tsOff
      } else {
        ts = this.fakeTs++
      }

      const { fields } = decodeFields(edef, data, off + hsz, view)
      off += rec
      this.consume(ts, eid, edef.name, fields)
      this.onRecord?.(this.base + off, ts)
      this.desync = false
      neu++
    }
    this.buf = data.subarray(off)
    this.base += off
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
    this.pm.unseal()
    const neu = this.decodeBuf()
    this.addProvisional()
    this.pm.seal(this.tr.t1)
    return neu
  }

  /**
   * Bytes fed but not decoded yet: the start of a record still being written.
   * A copy, so a recording can begin with them and stay record-aligned.
   */
  get pendingBytes(): Uint8Array {
    return this.buf.slice()
  }

  /**
   * A reader that carries on from where this one stands, with an empty trace.
   *
   * It keeps the table, the clock epoch, thread names and priorities, and what
   * every thread is doing, so a stream that resumes mid-flight decodes as it
   * would have here: the producer that was blocked is still blocked, rather
   * than unknown until its next switch. Each open state, ISR and run segment
   * restarts at this reader's newest timestamp, which becomes the fork's t0.
   * CPU power states start closed. Bytes held back for an incomplete record are
   * not carried over: feed {@link pendingBytes} first.
   */
  fork(): TraceReader {
    const r = new TraceReader(this.defs, this.hasTs)
    const tr = this.tr
    const at = tr.t1
    r.synced = this.synced
    r.netAddressWidth = this.netAddressWidth
    r.fakeTs = this.fakeTs
    r.prevRaw = this.prevRaw
    r.tsOff = this.tsOff
    r.curTid = this.curTid
    r.segStart = this.segStart === null ? null : Math.max(this.segStart, at)
    r.isrDepth = this.isrDepth
    r.running = this.running
    r.pends = this.pends
    r.nextWait = this.nextWait && { ...this.nextWait }
    for (const [tid, [state, since, reason, object]] of this.stCur) {
      r.stCur.set(tid, [state, Math.max(since, at), reason, object])
    }
    for (const [tid, [state, reason, object]] of this.stHint) r.stHint.set(tid, [state, reason, object])
    for (const [tid, cv] of this.condvarWaits) r.condvarWaits.set(tid, cv)
    for (const [tid, info] of tr.threads) r.tr.threads.set(tid, { ...info })
    r.tr.isrOpenStart = tr.isrOpenStart === null ? null : Math.max(tr.isrOpenStart, at)
    // A fork of a fork is how a replay starts over: the same place again.
    if (tr.events.length > 0 || this.anchored) {
      r.anchored = true
      r.newest = at
      r.tr.t0 = at
      r.tr.t1 = at
      r.addProvisional()
    }
    return r
  }

  /**
   * Where this reader was forked (its t0 for good), or null when it was not
   * forked from a reader that had decoded anything.
   */
  get forkedAt(): number | null {
    return this.anchored ? this.tr.t0 : null
  }

  /**
   * Set the trace's newest time to `ts`, as if nothing were logged after the
   * newest record: every thread holds its state up to there, as do an open ISR
   * and power state. A replay calls this so its timeline moves at the playback
   * rate instead of jumping from one record to the next. `ts` can go back down
   * as far as the newest record, not past it, and records fed afterwards must
   * not be older than it.
   */
  extendTo(ts: number): void {
    const tr = this.tr
    if (ts === tr.t1 || ts < this.newest || (tr.events.length === 0 && !this.anchored)) return
    this.dropProvisional()
    this.pm.unseal()
    tr.t1 = ts
    this.addProvisional()
    this.pm.seal(ts)
  }
}

/**
 * Thread ids for Gantt lanes: Zephyr priority ascending (lower = higher
 * priority; negative = cooperative), unknown prio last. Ties break by
 * thread id only — never by busy time, so live follow does not reshuffle.
 * `priorities` stands in where the trace never logged one, as for threads
 * created at run time.
 */
export function laneOrder(tr: Trace, priorities?: ReadonlyMap<number, number>): number[] {
  return [...tr.threads.keys()].sort((a, b) => {
    const pa = threadPrio(tr, a, priorities)
    const pb = threadPrio(tr, b, priorities)
    const aKnown = pa != null
    const bKnown = pb != null
    if (aKnown && bKnown && pa !== pb) return pa - pb
    if (aKnown !== bKnown) return aKnown ? -1 : 1
    return a - b
  })
}

/** Lanes worth painting: non-dead state somewhere in the trace. */
export function visibleLanes(tr: Trace, priorities?: ReadonlyMap<number, number>): number[] {
  return laneOrder(tr, priorities).filter((tid) => {
    const segs = tr.states.get(tid)
    return segs != null && segs.some(([, , st]) => st !== 'dead')
  })
}

export function threadLabel(tr: Trace, tid: number): string {
  return tr.threads.get(tid)?.name || '(unnamed)'
}

/**
 * Scheduler priority from CTF, else from `priorities` (what the debugger read
 * for a thread the trace never gave one), or null.
 */
export function threadPrio(
  tr: Trace,
  tid: number,
  priorities?: ReadonlyMap<number, number>,
): number | null {
  return tr.threads.get(tid)?.prio ?? priorities?.get(tid) ?? null
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

/** State of thread tid at time ts, with its reason and object as in {@link StateSeg}. */
export function stateAt(
  tr: Trace,
  tid: number,
  ts: number,
): [ThreadState | null, string, number | null] {
  const starts = tr.stateStarts.get(tid)
  const segs = tr.states.get(tid)
  if (!starts || !segs || !starts.length) return [null, '', null]
  const i = bisectRight(starts, ts) - 1
  if (i < 0) return [null, '', null]
  const [s, e, state, reason, object] = segs[i]!
  if (s <= ts && (ts < e || i === starts.length - 1)) return [state, reason, object]
  return [null, '', null]
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

/**
 * Scheduler-selected thread at `ts`, even when an ISR is interrupting it.
 *
 * Most callers want {@link threadRunningAt}; event-order reconstruction uses
 * this lower-level lookup after deciding whether that specific record is in
 * ISR context.
 */
export function scheduledThreadAt(tr: Trace, ts: number): number | null {
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

/** Running thread at ts (single-CPU), or null when unknown / in an ISR. */
export function threadRunningAt(tr: Trace, ts: number): number | null {
  // The interrupted thread remains the scheduler's current thread throughout
  // an ISR. Mask it here so ISR-originated kernel operations are not falsely
  // attributed to that thread.
  if (isrActiveAt(tr, ts)) return null
  return scheduledThreadAt(tr, ts)
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
