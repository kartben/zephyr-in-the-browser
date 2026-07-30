/**
 * CPU power state over time, reconstructed from the PM CTF events.
 *
 * The spine is `pm_state_set_enter` / `pm_state_set_exit` (0x149 / 0x14A) and
 * nothing else. Those two bracket the SoC code that parks the CPU with no
 * statements in between, so the timestamp delta *is* the residency — the guest
 * never measures or reports it, and the kernel's own CONFIG_PM_STATS is both
 * coarser (it collapses substates) and wrong on the IRQ-unlocked resume path.
 * They are also the only perfectly balanced pair in the PM event set.
 *
 * `pm_system_suspend_enter` / `_exit` are kept separately, as *decisions* rather
 * than segments. They carry what the policy was working with — the tick budget
 * it was handed and the state it settled on, including PM_STATE_ACTIVE meaning
 * "I declined to sleep at all" — but `enter` has an early-return path in
 * subsys/pm/pm.c that emits no exit, so an unmatched enter must never be drawn
 * as a span. Here it simply stays pending and invisible.
 *
 * ACTIVE is a gap, not a segment. That is a storage decision as much as a visual
 * one: on a busy guest these events fire on every idle, and `segs` is never
 * trimmed (see below), so storing the active spans would double an array that
 * only grows. It also makes the open tail trivially correct — nothing open means
 * the CPU is awake.
 *
 * Accumulated as it decodes, rather than derived from `Trace.events`, because
 * hostTrace trims that array in 5k batches with no generation counter: any
 * cursor into it silently skips 5,000 events after each trim. The reader is the
 * one place that sees every event exactly once, in order, before trimming.
 */

import {
  PM_DEVICE_ACTION_RUN_ENTER,
  PM_DEVICE_ACTION_RUN_EXIT,
  PM_STATE_SET_ENTER,
  PM_STATE_SET_EXIT,
  PM_SYSTEM_SUSPEND_ENTER,
  PM_SYSTEM_SUSPEND_EXIT,
} from './types'

/** `enum pm_device_action`: the first two are the system-managed walk's. */
const ACTION_SUSPEND = 0
const ACTION_RESUME = 1

/** `enum pm_state` value for "awake". Stored as a gap, never as a segment. */
export const PM_ACTIVE = 0

/** [start, end, state, substateId] — deliberately the shape of `StateSeg`. */
export type PmSeg = [start: number, end: number, state: number, substateId: number]

/**
 * One `pm_system_suspend` round trip: what the policy was offered, and chose.
 *
 * `state` and `declined` are derived from whether a `pm_state_set` pair happened
 * inside the round trip, *not* from the `state` field of
 * `pm_system_suspend_exit`. That field cannot be trusted on the success path:
 * subsys/pm/pm.c calls pm_system_resume() — which clears the per-CPU state
 * pointer — before the exit hook reads it, so the event reports PM_STATE_ACTIVE
 * for every successful suspend, indistinguishable from the paths that genuinely
 * stayed awake. Fixed upstream by reporting the latched local instead, but any
 * guest built before that still has it, and a trace viewer does not get to assume
 * its guest is new. The field is believed only when nothing was entered, which is
 * the one case it is right about.
 */
export interface PmDecision {
  ts: number
  cpu: number
  /** Ticks to the next timeout the policy was given, or null if `enter` was lost. */
  ticks: number | null
  /** The state it settled on. PM_ACTIVE means it declined to suspend. */
  state: number
  declined: boolean
}

/** The device suspend or resume walk around one state entry. */
export interface PmDeviceWalk {
  start: number
  end: number
  kind: 'suspend' | 'resume'
  /** Devices actually acted on, as the guest counted them. */
  count: number
  /** False only for a suspend walk that failed, which aborts the state entry. */
  ok: boolean
  /** Per-device actions inside the walk, in visit order. */
  actions: PmDeviceAction[]
}

export interface PmDeviceAction {
  start: number
  end: number
  /** `struct device *`, truncated to 32 bits by the guest. Names come from the ELF. */
  dev: number
  /** `enum pm_device_action`. */
  action: number
  /** 0, or a negative errno. -ENOSYS (-88) means the device has no PM at all. */
  ret: number
}

/** Residency distribution for one (cpu, state, substate) tuple. */
export interface PmTupleStats {
  cpu: number
  state: number
  substateId: number
  entries: number
  totalNs: number
  /** log2(ns) buckets, for a median that costs nothing to maintain. */
  buckets: Int32Array
}

/** A state entered whose exit has not been seen: what the CPU is doing *now*. */
export interface PmOpenState {
  since: number
  state: number
  substateId: number
}

export interface CpuPowerTimelines {
  /** cpu → closed segments in ts order. Gaps are PM_STATE_ACTIVE. */
  segs: Map<number, PmSeg[]>
  /** cpu → `segs[i][0]`, a parallel array for bisect. Mirrors `stateStarts`. */
  starts: Map<number, number[]>
  /**
   * cpu → the state currently held, if any.
   *
   * Not derivable from `segs`: a guest that suspends and never wakes emits its
   * enter as the very last event, so the sealed tail is zero-length and no
   * segment covers the live edge. Every transition emits an event, so "the last
   * thing entered" is knowledge, not a guess — and "the CPU is in standby right
   * now" is exactly the question a gutter readout is asked.
   */
  open: Map<number, PmOpenState>
  /** Policy decisions in ts order. */
  decisions: PmDecision[]
  /** Completed device walks in ts order. */
  walks: PmDeviceWalk[]
  /** tupleKey → residency distribution. */
  stats: Map<string, PmTupleStats>
  /** Unbalanced or nonsensical records, counted rather than guessed at. */
  dropped: {
    exitWithoutEnter: number
    enterWithoutExit: number
    outOfOrder: number
    activeEnter: number
  }
}

/**
 * Residency histogram resolution: buckets per power of two, and how many octaves
 * to cover (1 ns … ~2^40 ns ≈ 18 minutes).
 *
 * 16 per octave, not 1. Plain log2 buckets were a mistake: they are a factor of
 * two wide, so the pm_latency sample's 1.09 s, 1.19 s and 1.28 s residencies all
 * landed in the 2^30 bucket and every state reported the same "median 1.074s" —
 * three visibly different depths rendered identical. At 16 sub-buckets the step
 * is ~4.4%, comfortably finer than the three significant figures a 10px readout
 * shows, for 640 Int32 slots per tuple.
 */
const HIST_SUB = 16
const HIST_OCTAVES = 40
const HIST_BUCKETS = HIST_OCTAVES * HIST_SUB

export function emptyCpuPower(): CpuPowerTimelines {
  return {
    segs: new Map(),
    starts: new Map(),
    open: new Map(),
    decisions: [],
    walks: [],
    stats: new Map(),
    dropped: { exitWithoutEnter: 0, enterWithoutExit: 0, outOfOrder: 0, activeEnter: 0 },
  }
}

export function tupleKey(cpu: number, state: number, substateId: number): string {
  return `${cpu}/${state}/${substateId}`
}

function numField(fields: Record<string, string | number>, name: string, fallback = 0): number {
  const value = fields[name]
  return typeof value === 'number' ? value : fallback
}

type OpenWalk = {
  start: number
  kind: 'suspend' | 'resume'
  count: number
  actions: PmDeviceAction[]
}

/**
 * Folds the PM events into `CpuPowerTimelines`. Owned by TraceReader, kept here
 * so the state machine is testable on its own — the same split the queue and
 * socket reconstructions use.
 */
export class CpuPowerTracker {
  /** Published on `out` so consumers can ask what the CPU is doing right now. */
  private readonly open: Map<number, PmOpenState>
  private pendingEnter = new Map<number, { ts: number; ticks: number }>()
  private walk: OpenWalk | null = null
  private openAction: { start: number; dev: number; action: number } | null = null
  /** cpu → state entered since the current `pm_system_suspend_enter`. */
  private enteredSince = new Map<number, number>()
  /** Between `pm_system_suspend_enter` and its exit: the device-walk window. */
  private inSystemPm = false
  /** Whether this window reached a state, i.e. the suspend walk did not abort. */
  private sawStateSet = false
  /** CPUs whose open segment was published by `seal`, to undo in `unseal`. */
  private sealed: number[] = []

  constructor(readonly out: CpuPowerTimelines = emptyCpuPower()) {
    this.open = out.open
  }

  event(ts: number, eid: number, fields: Record<string, string | number>): void {
    switch (eid) {
      case PM_STATE_SET_ENTER:
        this.stateEnter(ts, fields)
        break
      case PM_STATE_SET_EXIT:
        this.stateExit(ts, fields)
        break
      case PM_SYSTEM_SUSPEND_ENTER:
        // A second enter with no exit between means the first took the
        // early-return path. Overwriting is the normal case, not an anomaly.
        this.closeWalk()
        this.pendingEnter.set(0, { ts, ticks: numField(fields, 'ticks') })
        this.enteredSince.delete(0)
        this.inSystemPm = true
        this.sawStateSet = false
        break
      case PM_SYSTEM_SUSPEND_EXIT:
        this.systemExit(ts, fields)
        break
      case PM_DEVICE_ACTION_RUN_ENTER:
        this.openAction = {
          start: ts,
          dev: numField(fields, 'dev'),
          action: numField(fields, 'action'),
        }
        break
      case PM_DEVICE_ACTION_RUN_EXIT:
        this.actionExit(ts, fields)
        break
      default:
        break
    }
  }

  private stateEnter(ts: number, fields: Record<string, string | number>) {
    const cpu = numField(fields, 'cpu')
    const state = numField(fields, 'state')
    if (state === PM_ACTIVE) {
      // pm_state_set is not called when the policy declines, so this should be
      // unreachable. Counted rather than drawn, so the band cannot claim the CPU
      // slept in a state that means "awake".
      this.out.dropped.activeEnter++
      return
    }
    const already = this.open.get(cpu)
    if (already) {
      // Lost exit. Close at this timestamp — the same conservative rule
      // closeIsrSpan uses — rather than letting one segment swallow the trace.
      this.out.dropped.enterWithoutExit++
      this.push(cpu, already, ts)
    }
    this.open.set(cpu, { since: ts, state, substateId: numField(fields, 'substate_id') })
    this.enteredSince.set(cpu, state)
    // The suspend walk is over, and reaching a state means it succeeded.
    this.sawStateSet = true
    this.closeWalk()
  }

  private stateExit(ts: number, fields: Record<string, string | number>) {
    const cpu = numField(fields, 'cpu')
    const open = this.open.get(cpu)
    if (!open) {
      // Never synthesise a start: guessing one is how a single segment ends up
      // covering the whole trace.
      this.out.dropped.exitWithoutEnter++
      return
    }
    if (ts < open.since) {
      this.out.dropped.outOfOrder++
      return
    }
    this.open.delete(cpu)
    this.push(cpu, open, ts)
  }

  private systemExit(ts: number, fields: Record<string, string | number>) {
    this.closeWalk()
    this.inSystemPm = false
    const cpu = 0
    const pending = this.pendingEnter.get(cpu)
    this.pendingEnter.delete(cpu)
    // See the note on PmDecision: prefer what we watched happen over what the
    // event claims, because on older guests the claim is always ACTIVE.
    const entered = this.enteredSince.get(cpu)
    this.enteredSince.delete(cpu)
    const state = entered ?? numField(fields, 'state')
    this.out.decisions.push({
      ts,
      cpu,
      ticks: pending ? pending.ticks : null,
      state,
      declined: state === PM_ACTIVE,
    })
  }

  /**
   * Publish the open walk, deriving what the dropped bracket events used to say.
   *
   * `count` is actions that returned 0, because device_system_managed.c
   * increments num_susp only after the -ENOSYS/-ENOTSUP/-EALREADY ignore and the
   * error return — so a zero return is exactly "this one was suspended".
   *
   * `ok` is false only for a suspend walk in a window that never reached
   * `pm_state_set_enter`: pm.c rolls the devices back and returns without
   * entering a state, which is the abort path and the only way a walk fails.
   */
  private closeWalk() {
    const walk = this.walk
    this.walk = null
    if (!walk || walk.actions.length === 0) return
    const start = walk.actions[0].start
    const end = walk.actions[walk.actions.length - 1].end
    if (end < start) return
    this.out.walks.push({
      start,
      end,
      kind: walk.kind,
      count: walk.actions.filter((a) => a.ret === 0).length,
      ok: walk.kind === 'resume' || this.sawStateSet,
      actions: walk.actions,
    })
  }

  private actionExit(ts: number, fields: Record<string, string | number>) {
    const open = this.openAction
    this.openAction = null
    const dev = numField(fields, 'dev')
    const code = numField(fields, 'action')
    const action: PmDeviceAction = {
      start: open && open.dev === dev ? open.start : ts,
      end: ts,
      dev,
      action: code,
      ret: numField(fields, 'ret'),
    }

    /*
     * Only actions inside a system-PM window belong to the walk. Device runtime
     * PM and power domains run actions too, and attributing those to a walk
     * would invent one that never ran.
     *
     * Scoping by position is sound because pm.c calls pm_suspend_devices()
     * strictly before pm_state_set_enter and pm_resume_devices() strictly after
     * pm_state_set_exit, and kernel/idle.c holds arch_irq_lock() across the whole
     * of pm_system_suspend() — so nothing can interleave into the window.
     */
    if (!this.inSystemPm) return
    if (code !== ACTION_SUSPEND && code !== ACTION_RESUME) return

    // Split on the action code rather than on the phase: the abort path runs a
    // suspend walk *and* a rollback resume walk inside one window, with no
    // state_set pair between them to separate the two.
    const kind = code === ACTION_SUSPEND ? 'suspend' : 'resume'
    if (this.walk && this.walk.kind !== kind) this.closeWalk()
    if (!this.walk) this.walk = { start: action.start, kind, count: 0, actions: [] }
    this.walk.actions.push(action)
  }

  private push(cpu: number, open: PmOpenState, end: number) {
    if (end <= open.since) return
    const segs = this.out.segs.get(cpu) ?? []
    segs.push([open.since, end, open.state, open.substateId])
    this.out.segs.set(cpu, segs)
    const starts = this.out.starts.get(cpu) ?? []
    starts.push(open.since)
    this.out.starts.set(cpu, starts)
    this.record(cpu, open, end - open.since)
  }

  private record(cpu: number, open: PmOpenState, ns: number) {
    const key = tupleKey(cpu, open.state, open.substateId)
    let stat = this.out.stats.get(key)
    if (!stat) {
      stat = {
        cpu,
        state: open.state,
        substateId: open.substateId,
        entries: 0,
        totalNs: 0,
        buckets: new Int32Array(HIST_BUCKETS),
      }
      this.out.stats.set(key, stat)
    }
    stat.entries++
    stat.totalNs += ns
    stat.buckets[bucketOf(ns)]++
  }

  /**
   * Publish the still-open segment of every suspended CPU, ending at the live
   * edge, so the tail is drawable and queryable without every call site special
   * casing it. Provisional: `unseal` removes them again before the next decode.
   *
   * The same hazard as the thread states applies — leaving the tail out lets the
   * previously closed segment read as the current state forever — so the seal
   * happens even when `t1` equals the segment start.
   */
  seal(t1: number): void {
    for (const [cpu, open] of this.open) {
      if (t1 < open.since) continue
      const segs = this.out.segs.get(cpu) ?? []
      segs.push([open.since, Math.max(open.since, t1), open.state, open.substateId])
      this.out.segs.set(cpu, segs)
      const starts = this.out.starts.get(cpu) ?? []
      starts.push(open.since)
      this.out.starts.set(cpu, starts)
      this.sealed.push(cpu)
    }
  }

  unseal(): void {
    for (const cpu of this.sealed) {
      this.out.segs.get(cpu)?.pop()
      this.out.starts.get(cpu)?.pop()
    }
    this.sealed = []
  }
}

function bucketOf(ns: number): number {
  if (ns <= 1) return 0
  const b = Math.floor(Math.log2(ns) * HIST_SUB)
  return b < 0 ? 0 : b >= HIST_BUCKETS ? HIST_BUCKETS - 1 : b
}

/** CPUs that ever suspended, ascending. Never invented — only what was seen. */
export function cpuPowerLanes(tl: CpuPowerTimelines): number[] {
  return [...tl.segs.keys()].sort((a, b) => a - b)
}

/** Whether there is anything at all to draw. Gates the whole feature. */
export function hasCpuPower(tl: CpuPowerTimelines): boolean {
  return tl.segs.size > 0 || tl.decisions.length > 0
}

/** Index of the last start <= ts, or -1. */
function bisect(starts: number[], ts: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= ts) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** The segment covering `ts`, or null when the CPU was active (a gap). */
export function pmStateAt(tl: CpuPowerTimelines, cpu: number, ts: number): PmSeg | null {
  const segs = tl.segs.get(cpu)
  const starts = tl.starts.get(cpu)
  if (!segs || !starts) return null
  const i = bisect(starts, ts)
  if (i < 0) return null
  const seg = segs[i]
  return seg && ts < seg[1] ? seg : null
}

/**
 * The state a CPU is in at `ts`, falling back to the still-open state when the
 * probe is at or past it.
 *
 * The fallback is the case a plain segment lookup cannot answer: a guest that
 * suspends and never wakes emits its enter last, so the tail segment has zero
 * width and covers nothing. Returns null only when the CPU is genuinely awake.
 */
export function pmStateAtOrOpen(
  tl: CpuPowerTimelines,
  cpu: number,
  ts: number,
): { state: number; substateId: number; since: number; end: number | null } | null {
  const seg = pmStateAt(tl, cpu, ts)
  if (seg) return { state: seg[2], substateId: seg[3], since: seg[0], end: seg[1] }
  const open = tl.open.get(cpu)
  if (open && ts >= open.since) {
    return { state: open.state, substateId: open.substateId, since: open.since, end: null }
  }
  return null
}

/**
 * Visit every segment overlapping [view0, view1], clipped to it.
 *
 * Exact nanoseconds, with no column rasterisation: the transition is the thing
 * worth being accurate about, and the raster smears one to the left by up to a
 * column. One band per CPU does not need the raster's speed.
 */
export function forEachPmInView(
  tl: CpuPowerTimelines,
  cpu: number,
  view0: number,
  view1: number,
  visit: (start: number, end: number, state: number, substateId: number) => void,
): void {
  const segs = tl.segs.get(cpu)
  const starts = tl.starts.get(cpu)
  if (!segs || !starts) return
  const from = Math.max(0, bisect(starts, view0))
  for (let i = from; i < segs.length; i++) {
    const [s, e, state, sub] = segs[i]
    if (s >= view1) break
    if (e <= view0) continue
    visit(Math.max(s, view0), Math.min(e, view1), state, sub)
  }
}

export interface PmWindowStats {
  /** Nanoseconds not spent active, summed over the window. */
  sleptNs: number
  windowNs: number
  /** Fraction of the window spent suspended, 0..1. */
  sleptFraction: number
  /** Per-tuple nanoseconds in the window, keyed by tupleKey. */
  byTuple: Map<string, number>
  /** Deepest `pm_state` reached in the window, or null if it stayed active. */
  deepest: number | null
  entries: number
}

export function pmWindowStats(
  tl: CpuPowerTimelines,
  cpu: number,
  view0: number,
  view1: number,
): PmWindowStats {
  const byTuple = new Map<string, number>()
  let sleptNs = 0
  let deepest: number | null = null
  let entries = 0
  forEachPmInView(tl, cpu, view0, view1, (s, e, state, sub) => {
    const ns = e - s
    sleptNs += ns
    entries++
    const key = tupleKey(cpu, state, sub)
    byTuple.set(key, (byTuple.get(key) ?? 0) + ns)
    if (deepest === null || state > deepest) deepest = state
  })
  const windowNs = Math.max(0, view1 - view0)
  return {
    sleptNs,
    windowNs,
    sleptFraction: windowNs > 0 ? Math.min(1, sleptNs / windowNs) : 0,
    byTuple,
    deepest,
    entries,
  }
}

/**
 * Median residency for a tuple, read off the log2 histogram.
 *
 * The mean is meaningless for this distribution — one multi-second sleep among
 * thousands of microsecond ones — and an exact p50 over an array that is never
 * trimmed is unbounded work on every repaint. Bucket resolution is a factor of
 * two, which is well inside the three significant figures a 10px readout shows.
 */
export function medianResidencyNs(stat: PmTupleStats): number {
  if (stat.entries === 0) return 0
  const half = stat.entries / 2
  let seen = 0
  for (let b = 0; b < stat.buckets.length; b++) {
    seen += stat.buckets[b]
    // Mid-bucket rather than the lower edge: the bucket spans [2^(b/S),
    // 2^((b+1)/S)), and reporting its floor biases every reading low.
    if (seen >= half) return 2 ** ((b + 0.5) / HIST_SUB)
  }
  return 0
}

/**
 * Depth ramp: one hue, six steps, monotone in lightness *and* chroma.
 *
 * Sequential and not categorical because `pm_state` is ordinal — six unrelated
 * hues cannot be ordered by eye, and this canvas has almost no unclaimed hues
 * left. The hue deliberately sits next to the `slp` cyan of the thread lanes:
 * CPU suspend and thread sleep are the same idea at different scopes, so a reader
 * who has learned "cyan is sleeping" gets this row for free.
 *
 * The shallow end is *not* subtle, and that was a correction: a first pass at
 * `oklch(0.55 0.04 215 / 0.55)` was nearly indistinguishable from the lane trough
 * a gap reveals, which is the one distinction the row exists to make. Quiet is
 * right for the legend, wrong for the floor of the ramp. Values come from
 * docs/cpu-power-mockup.html, where they were compared against every colour
 * already on this canvas.
 *
 * Alpha is baked into each stop so one ramp step is one constant rather than a
 * globalAlpha dance; `oklch()` in Canvas 2D is precedented in
 * CanArbitrationLanes.ts.
 */
export const PM_RAMP = [
  'oklch(0.60 0.075 216 / 0.80)',
  'oklch(0.67 0.11 213 / 0.88)',
  'oklch(0.73 0.14 210 / 0.93)',
  'oklch(0.78 0.16 208 / 0.96)',
  'oklch(0.82 0.18 206 / 0.98)',
  'oklch(0.86 0.19 204 / 1)',
] as const

/** Policy-decline notches. `--warning` amber, the only warm ink in the section. */
export const PM_NOTCH_COLOR = 'oklch(0.77 0.15 78 / 0.5)'

/**
 * Fill and bar height for a depth rank.
 *
 * `rank` is 1-based: the position in the devicetree's `cpu-power-states` when it
 * is known, else the raw `pm_state`. Height is binary rather than proportional
 * because six levels in a 9px bar is unreadable and two is instant, and the break
 * is at `PM_STATE_STANDBY` — exactly where Zephyr's semantics break, since that
 * is where CPU context starts being lost. So a squat bar means "light nap, cheap
 * wake" and a full bar means "we went deep".
 *
 * `rankCount` normalises a short ladder across the ramp instead of leaving it
 * huddled at the bottom, with a floor of 4 so a 2-state board does not paint its
 * shallowest state in the brightest colour.
 */
export function pmFill(rank: number, rankCount: number, state: number): { fill: string; full: boolean } {
  const steps = Math.max(rankCount, 4)
  const scaled = Math.round(((rank - 1) / Math.max(1, steps - 1)) * (PM_RAMP.length - 1))
  const index = Math.min(PM_RAMP.length - 1, Math.max(0, scaled))
  return { fill: PM_RAMP[index], full: state >= 3 }
}

/** Decisions overlapping a window, in ts order. */
export function decisionsInView(
  tl: CpuPowerTimelines,
  view0: number,
  view1: number,
): PmDecision[] {
  return tl.decisions.filter((d) => d.ts >= view0 && d.ts <= view1)
}

/** Device walks overlapping a window, in ts order. */
export function walksInView(
  tl: CpuPowerTimelines,
  view0: number,
  view1: number,
): PmDeviceWalk[] {
  return tl.walks.filter((w) => w.end > view0 && w.start < view1)
}
