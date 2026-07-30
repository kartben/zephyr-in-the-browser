import { describe, expect, it } from 'vitest'
import {
  CpuPowerTracker,
  PM_RAMP,
  pmFill,
  cpuPowerLanes,
  decisionsInView,
  emptyCpuPower,
  forEachPmInView,
  hasCpuPower,
  medianResidencyNs,
  pmStateAt,
  pmStateAtOrOpen,
  pmWindowStats,
  tupleKey,
  walksInView,
} from './cpuPower'
import {
  PM_DEVICE_ACTION_RUN_ENTER,
  PM_DEVICE_ACTION_RUN_EXIT,
  PM_RESUME_DEVICES_ENTER,
  PM_RESUME_DEVICES_EXIT,
  PM_STATE_SET_ENTER,
  PM_STATE_SET_EXIT,
  PM_SUSPEND_DEVICES_ENTER,
  PM_SUSPEND_DEVICES_EXIT,
  PM_SYSTEM_SUSPEND_ENTER,
  PM_SYSTEM_SUSPEND_EXIT,
} from './types'

const RUNTIME_IDLE = 1
const SUSPEND_TO_IDLE = 2
const STANDBY = 3

function tracker() {
  return new CpuPowerTracker(emptyCpuPower())
}

/** One complete suspend: policy consulted, state entered, state left. */
function sleep(
  t: CpuPowerTracker,
  at: number,
  until: number,
  state: number,
  { cpu = 0, sub = 0, ticks = 120 } = {},
) {
  t.event(at, PM_SYSTEM_SUSPEND_ENTER, { ticks })
  t.event(at, PM_STATE_SET_ENTER, { cpu, state, substate_id: sub })
  t.event(until, PM_STATE_SET_EXIT, { cpu, state, substate_id: sub })
  t.event(until, PM_SYSTEM_SUSPEND_EXIT, { ticks, state })
}

describe('CpuPowerTracker', () => {
  it('turns an enter/exit pair into a segment whose length is the residency', () => {
    const t = tracker()
    sleep(t, 1_000, 1_100_000_000, RUNTIME_IDLE)
    expect(t.out.segs.get(0)).toEqual([[1_000, 1_100_000_000, RUNTIME_IDLE, 0]])
    expect(t.out.starts.get(0)).toEqual([1_000])
    expect(t.out.dropped).toEqual({
      exitWithoutEnter: 0,
      enterWithoutExit: 0,
      outOfOrder: 0,
      activeEnter: 0,
    })
  })

  it('stores active as a gap, so a query between sleeps returns null', () => {
    const t = tracker()
    sleep(t, 100, 200, RUNTIME_IDLE)
    sleep(t, 500, 900, STANDBY)
    expect(t.out.segs.get(0)).toHaveLength(2)
    expect(pmStateAt(t.out, 0, 150)?.[2]).toBe(RUNTIME_IDLE)
    expect(pmStateAt(t.out, 0, 300)).toBeNull() // awake between them
    expect(pmStateAt(t.out, 0, 600)?.[2]).toBe(STANDBY)
    expect(pmStateAt(t.out, 0, 900)).toBeNull() // end is exclusive
    expect(pmStateAt(t.out, 0, 50)).toBeNull() // before anything
  })

  it('keeps a separate timeline per cpu', () => {
    const t = tracker()
    sleep(t, 100, 200, RUNTIME_IDLE, { cpu: 0 })
    sleep(t, 120, 400, STANDBY, { cpu: 1 })
    expect(cpuPowerLanes(t.out)).toEqual([0, 1])
    expect(pmStateAt(t.out, 1, 300)?.[2]).toBe(STANDBY)
    expect(pmStateAt(t.out, 0, 300)).toBeNull()
  })

  it('distinguishes substates that share one pm_state value', () => {
    const t = tracker()
    sleep(t, 100, 200, SUSPEND_TO_IDLE, { sub: 1 })
    sleep(t, 300, 500, SUSPEND_TO_IDLE, { sub: 3 })
    expect(t.out.segs.get(0)?.map((s) => s[3])).toEqual([1, 3])
    expect(t.out.stats.size).toBe(2)
    expect([...t.out.stats.keys()]).toEqual([tupleKey(0, 2, 1), tupleKey(0, 2, 3)])
  })

  describe('malformed streams', () => {
    it('drops an exit with no enter instead of inventing a start', () => {
      const t = tracker()
      t.event(500, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.segs.get(0)).toBeUndefined()
      expect(t.out.dropped.exitWithoutEnter).toBe(1)
    })

    it('closes a lost enter at the next enter rather than swallowing the trace', () => {
      const t = tracker()
      t.event(100, PM_STATE_SET_ENTER, { cpu: 0, state: RUNTIME_IDLE, substate_id: 0 })
      t.event(400, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.event(900, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.dropped.enterWithoutExit).toBe(1)
      expect(t.out.segs.get(0)).toEqual([
        [100, 400, RUNTIME_IDLE, 0],
        [400, 900, STANDBY, 0],
      ])
    })

    it('refuses an enter that claims PM_STATE_ACTIVE', () => {
      const t = tracker()
      t.event(100, PM_STATE_SET_ENTER, { cpu: 0, state: 0, substate_id: 0 })
      t.event(200, PM_STATE_SET_EXIT, { cpu: 0, state: 0, substate_id: 0 })
      expect(t.out.dropped.activeEnter).toBe(1)
      // The exit then has nothing to close, which is counted too.
      expect(t.out.dropped.exitWithoutEnter).toBe(1)
      expect(hasCpuPower(t.out)).toBe(false)
    })

    it('drops a backwards exit', () => {
      const t = tracker()
      t.event(500, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.event(100, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.dropped.outOfOrder).toBe(1)
      expect(t.out.segs.get(0)).toBeUndefined()
    })

    it('discards a zero-length segment', () => {
      const t = tracker()
      t.event(100, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.event(100, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.segs.get(0)).toBeUndefined()
    })
  })

  describe('the open tail under live follow', () => {
    it('seals an in-progress sleep to the live edge and unseals it again', () => {
      const t = tracker()
      t.event(1_000, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.seal(5_000)
      expect(t.out.segs.get(0)).toEqual([[1_000, 5_000, STANDBY, 0]])
      expect(pmStateAt(t.out, 0, 4_000)?.[2]).toBe(STANDBY)

      // Next poll: the provisional tail comes off before more bytes decode, so
      // it cannot accumulate or be double-counted.
      t.unseal()
      expect(t.out.segs.get(0)).toEqual([])
      t.seal(9_000)
      expect(t.out.segs.get(0)).toEqual([[1_000, 9_000, STANDBY, 0]])
    })

    it('seals at the segment start too, so a fresh enter is already visible', () => {
      // The mirror of addProvisional's `last >= since` scar: with a strict `>`
      // the previous closed segment would read as the current state forever.
      const t = tracker()
      t.event(1_000, PM_STATE_SET_ENTER, { cpu: 0, state: RUNTIME_IDLE, substate_id: 0 })
      t.seal(1_000)
      expect(t.out.segs.get(0)).toEqual([[1_000, 1_000, RUNTIME_IDLE, 0]])
    })

    it('answers "what now" for a guest that suspends and never wakes', () => {
      /*
       * The real shape of samples/subsys/pm/latency: main() returns and the CPU
       * parks in standby forever, so the enter is the very last event and the
       * sealed tail has zero width. pmStateAt alone reports the CPU awake — the
       * one thing it certainly is not.
       */
      const t = tracker()
      sleep(t, 0, 1_000, RUNTIME_IDLE)
      t.event(2_000, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.seal(2_000)

      expect(pmStateAt(t.out, 0, 2_000)).toBeNull()
      expect(pmStateAtOrOpen(t.out, 0, 2_000)).toMatchObject({
        state: STANDBY,
        since: 2_000,
        end: null,
      })
      // Later still, because nothing has happened since.
      expect(pmStateAtOrOpen(t.out, 0, 9_999)?.state).toBe(STANDBY)
      // But not before it was entered, and not in the earlier gap.
      expect(pmStateAtOrOpen(t.out, 0, 1_500)).toBeNull()
      // A closed segment still reports its end, so residency stays knowable.
      expect(pmStateAtOrOpen(t.out, 0, 500)).toMatchObject({ state: RUNTIME_IDLE, end: 1_000 })
    })

    it('stops reporting an open state once it closes', () => {
      const t = tracker()
      t.event(1_000, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(pmStateAtOrOpen(t.out, 0, 5_000)?.state).toBe(STANDBY)
      t.event(2_000, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.open.size).toBe(0)
      expect(pmStateAtOrOpen(t.out, 0, 5_000)).toBeNull()
    })

    it('does not seal a cpu that is awake', () => {
      const t = tracker()
      sleep(t, 100, 200, RUNTIME_IDLE)
      t.seal(9_000)
      expect(t.out.segs.get(0)).toEqual([[100, 200, RUNTIME_IDLE, 0]])
      expect(pmStateAt(t.out, 0, 5_000)).toBeNull()
    })

    it('counts a sealed segment only once it really closes', () => {
      const t = tracker()
      t.event(1_000, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.seal(5_000)
      expect(t.out.stats.get(tupleKey(0, STANDBY, 0))).toBeUndefined()
      t.unseal()
      t.event(6_000, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      expect(t.out.stats.get(tupleKey(0, STANDBY, 0))?.entries).toBe(1)
      expect(t.out.stats.get(tupleKey(0, STANDBY, 0))?.totalNs).toBe(5_000)
    })
  })

  describe('policy decisions', () => {
    it('records the tick budget and the state chosen', () => {
      const t = tracker()
      sleep(t, 100, 900, STANDBY, { ticks: 130 })
      expect(t.out.decisions).toEqual([
        { ts: 900, cpu: 0, ticks: 130, state: STANDBY, declined: false },
      ])
    })

    it('marks a declined suspend, which enters no state at all', () => {
      const t = tracker()
      t.event(100, PM_SYSTEM_SUSPEND_ENTER, { ticks: 3 })
      t.event(110, PM_SYSTEM_SUSPEND_EXIT, { ticks: 3, state: 0 })
      expect(t.out.decisions[0]).toMatchObject({ ticks: 3, declined: true })
      expect(t.out.segs.size).toBe(0)
      // A decline is still evidence the policy ran, so the feature is live.
      expect(hasCpuPower(t.out)).toBe(true)
    })

    it('trusts the state it watched being entered over the reported field', () => {
      // A guest built before the pm.c fix reports PM_STATE_ACTIVE on every
      // successful suspend, because pm_system_resume() clears the state pointer
      // before the exit hook reads it. Taking that at face value would mark
      // every real sleep as "policy declined".
      const t = tracker()
      t.event(100, PM_SYSTEM_SUSPEND_ENTER, { ticks: 130 })
      t.event(110, PM_STATE_SET_ENTER, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.event(900, PM_STATE_SET_EXIT, { cpu: 0, state: STANDBY, substate_id: 0 })
      t.event(910, PM_SYSTEM_SUSPEND_EXIT, { ticks: 130, state: 0 })
      expect(t.out.decisions[0]).toMatchObject({ state: STANDBY, declined: false })
    })

    it('still believes the field when no state was entered', () => {
      const t = tracker()
      t.event(100, PM_SYSTEM_SUSPEND_ENTER, { ticks: 2 })
      t.event(110, PM_SYSTEM_SUSPEND_EXIT, { ticks: 2, state: 0 })
      expect(t.out.decisions[0]).toMatchObject({ state: 0, declined: true })
    })

    it('does not carry a state across into the next round trip', () => {
      const t = tracker()
      sleep(t, 100, 900, STANDBY, { ticks: 130 })
      t.event(1_000, PM_SYSTEM_SUSPEND_ENTER, { ticks: 2 })
      t.event(1_010, PM_SYSTEM_SUSPEND_EXIT, { ticks: 2, state: 0 })
      expect(t.out.decisions.map((d) => d.declined)).toEqual([false, true])
    })

    it('never draws a dangling enter, and reports a null budget when it is lost', () => {
      // subsys/pm/pm.c returns early with no exit when every state is locked.
      const t = tracker()
      t.event(100, PM_SYSTEM_SUSPEND_ENTER, { ticks: 50 })
      t.event(200, PM_SYSTEM_SUSPEND_ENTER, { ticks: 60 })
      t.event(300, PM_SYSTEM_SUSPEND_EXIT, { ticks: 60, state: 0 })
      expect(t.out.decisions).toHaveLength(1)
      expect(t.out.decisions[0]?.ticks).toBe(60)

      t.event(400, PM_SYSTEM_SUSPEND_EXIT, { ticks: 70, state: 0 })
      expect(t.out.decisions[1]?.ticks).toBeNull()
    })
  })

  describe('the system-managed device walk', () => {
    it('nests per-device actions inside the walk that ran them', () => {
      const t = tracker()
      t.event(1_000, PM_SUSPEND_DEVICES_ENTER, {})
      t.event(1_010, PM_DEVICE_ACTION_RUN_ENTER, { dev: 0x4001_0100, action: 0 })
      t.event(1_130, PM_DEVICE_ACTION_RUN_EXIT, { dev: 0x4001_0100, action: 0, ret: 0 })
      t.event(1_140, PM_DEVICE_ACTION_RUN_ENTER, { dev: 0x4001_0200, action: 0 })
      t.event(1_150, PM_DEVICE_ACTION_RUN_EXIT, { dev: 0x4001_0200, action: 0, ret: -88 })
      t.event(1_200, PM_SUSPEND_DEVICES_EXIT, { count: 1, ok: 1 })

      const walk = t.out.walks[0]
      expect(walk).toMatchObject({ start: 1_000, end: 1_200, kind: 'suspend', count: 1, ok: true })
      expect(walk?.actions).toHaveLength(2)
      expect(walk?.actions[0]).toMatchObject({ start: 1_010, end: 1_130, ret: 0 })
      // -ENOSYS: a device with no PM support at all, which the walk ignores —
      // hence count 1 rather than 2.
      expect(walk?.actions[1]?.ret).toBe(-88)
    })

    it('records a failed suspend walk, which aborts the state entry', () => {
      const t = tracker()
      t.event(1_000, PM_SUSPEND_DEVICES_ENTER, {})
      t.event(1_100, PM_SUSPEND_DEVICES_EXIT, { count: 2, ok: 0 })
      expect(t.out.walks[0]).toMatchObject({ ok: false, count: 2 })
    })

    it('carries the resume count on the enter, where the guest reports it', () => {
      const t = tracker()
      t.event(2_000, PM_RESUME_DEVICES_ENTER, { count: 3 })
      t.event(2_600, PM_RESUME_DEVICES_EXIT, {})
      expect(t.out.walks[0]).toMatchObject({ kind: 'resume', count: 3, ok: true })
    })

    it('ignores device actions outside a walk — runtime PM and power domains', () => {
      const t = tracker()
      t.event(100, PM_DEVICE_ACTION_RUN_ENTER, { dev: 0x4001_0100, action: 1 })
      t.event(200, PM_DEVICE_ACTION_RUN_EXIT, { dev: 0x4001_0100, action: 1, ret: 0 })
      expect(t.out.walks).toHaveLength(0)
    })
  })
})

describe('queries', () => {
  function walked() {
    const t = tracker()
    sleep(t, 0, 1_000, RUNTIME_IDLE)
    sleep(t, 2_000, 5_000, SUSPEND_TO_IDLE)
    sleep(t, 6_000, 10_000, STANDBY)
    return t.out
  }

  it('clips segments to the view window', () => {
    const seen: Array<[number, number, number]> = []
    forEachPmInView(walked(), 0, 500, 7_000, (s, e, state) => seen.push([s, e, state]))
    expect(seen).toEqual([
      [500, 1_000, RUNTIME_IDLE],
      [2_000, 5_000, SUSPEND_TO_IDLE],
      [6_000, 7_000, STANDBY],
    ])
  })

  it('visits nothing for a window inside a gap', () => {
    const seen: number[] = []
    forEachPmInView(walked(), 0, 1_200, 1_800, (s) => seen.push(s))
    expect(seen).toEqual([])
  })

  it('sums slept time and names the deepest state in the window', () => {
    const stats = pmWindowStats(walked(), 0, 0, 10_000)
    expect(stats.sleptNs).toBe(1_000 + 3_000 + 4_000)
    expect(stats.windowNs).toBe(10_000)
    expect(stats.sleptFraction).toBeCloseTo(0.8)
    expect(stats.deepest).toBe(STANDBY)
    expect(stats.entries).toBe(3)
    expect(stats.byTuple.get(tupleKey(0, STANDBY, 0))).toBe(4_000)
  })

  it('reports an all-active window as zero rather than as missing data', () => {
    const stats = pmWindowStats(walked(), 0, 1_100, 1_900)
    expect(stats.sleptNs).toBe(0)
    expect(stats.sleptFraction).toBe(0)
    expect(stats.deepest).toBeNull()
  })

  it('filters decisions and walks to the window', () => {
    const t = tracker()
    sleep(t, 0, 1_000, RUNTIME_IDLE)
    sleep(t, 5_000, 9_000, STANDBY)
    t.event(4_000, PM_SUSPEND_DEVICES_ENTER, {})
    t.event(4_500, PM_SUSPEND_DEVICES_EXIT, { count: 3, ok: 1 })
    expect(decisionsInView(t.out, 0, 2_000).map((d) => d.ts)).toEqual([1_000])
    expect(walksInView(t.out, 0, 2_000)).toHaveLength(0)
    expect(walksInView(t.out, 4_200, 4_300)).toHaveLength(1)
  })

  it('separates residencies that differ by only ~10%', () => {
    /*
     * The regression that plain log2 buckets caused: pm_latency's three depths
     * are ~1.09s, ~1.19s and ~1.28s, all inside the 2^30 octave, so every state
     * reported the same "median 1.074s". Three visibly different depths must not
     * render identical.
     */
    const t = tracker()
    sleep(t, 0, 1_094_000_000, RUNTIME_IDLE)
    sleep(t, 2_000_000_000, 2_000_000_000 + 1_192_000_000, SUSPEND_TO_IDLE)
    sleep(t, 5_000_000_000, 5_000_000_000 + 1_276_000_000, STANDBY)

    const med = (state: number) =>
      medianResidencyNs(t.out.stats.get(tupleKey(0, state, 0))!)
    expect(med(RUNTIME_IDLE)).not.toBe(med(SUSPEND_TO_IDLE))
    expect(med(SUSPEND_TO_IDLE)).not.toBe(med(STANDBY))
    expect(med(RUNTIME_IDLE)).toBeLessThan(med(SUSPEND_TO_IDLE))
    expect(med(SUSPEND_TO_IDLE)).toBeLessThan(med(STANDBY))
    // And each within ~5% of the truth, so the number is worth printing.
    expect(med(RUNTIME_IDLE)).toBeCloseTo(1_094_000_000, -8)
    expect(med(STANDBY) / 1_276_000_000).toBeCloseTo(1, 1)
  })

  it('reads a median off the histogram, unmoved by one huge outlier', () => {
    const t = tracker()
    // Nine ~1 µs sleeps and one 4 s sleep: the mean is ~400 ms, the median is
    // the ~1 µs the CPU actually does almost every time.
    for (let i = 0; i < 9; i++) sleep(t, i * 10_000, i * 10_000 + 1_000, RUNTIME_IDLE)
    sleep(t, 200_000, 4_000_200_000, RUNTIME_IDLE)
    const stat = t.out.stats.get(tupleKey(0, RUNTIME_IDLE, 0))!
    expect(stat.entries).toBe(10)
    expect(stat.totalNs / stat.entries).toBeGreaterThan(300_000_000)
    expect(medianResidencyNs(stat)).toBeLessThan(2_000)
  })

  it('maps rank to a ramp step, monotonically and within bounds', () => {
    const first = pmFill(1, 3, RUNTIME_IDLE)
    const last = pmFill(3, 3, STANDBY)
    expect(PM_RAMP).toContain(first.fill)
    expect(PM_RAMP).toContain(last.fill)
    expect(PM_RAMP.indexOf(last.fill as never)).toBeGreaterThan(
      PM_RAMP.indexOf(first.fill as never),
    )
    // Height is binary and breaks at STANDBY, where CPU context starts to go.
    expect(first.full).toBe(false)
    expect(pmFill(2, 3, SUSPEND_TO_IDLE).full).toBe(false)
    expect(last.full).toBe(true)
  })

  it('does not paint a two-state board in the brightest colour', () => {
    // rankCount floors at 4, so a short ladder stays in the lower ramp.
    expect(pmFill(2, 2, SUSPEND_TO_IDLE).fill).not.toBe(PM_RAMP[PM_RAMP.length - 1])
  })

  it('clamps a rank beyond the declared ladder', () => {
    expect(PM_RAMP).toContain(pmFill(99, 3, 6).fill)
    expect(PM_RAMP).toContain(pmFill(0, 3, 1).fill)
  })

  it('answers on an empty timeline without throwing', () => {
    const tl = emptyCpuPower()
    expect(hasCpuPower(tl)).toBe(false)
    expect(cpuPowerLanes(tl)).toEqual([])
    expect(pmStateAt(tl, 0, 5)).toBeNull()
    expect(pmWindowStats(tl, 0, 0, 100).sleptFraction).toBe(0)
    forEachPmInView(tl, 0, 0, 100, () => expect.unreachable())
  })
})
