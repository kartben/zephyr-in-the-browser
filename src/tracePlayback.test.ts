/**
 * Recording the live Trace and replaying it: the bytes a recording keeps, and
 * a replay that shows, at any cursor, what the live decoder showed then.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackDefs, TraceReader, type StateSeg, type Trace } from '@/ctf'
import * as hostTrace from '@/hostTrace'
import { TraceReplay } from '@/tracePlayback'
import * as recorder from '@/traceRecorder'
import { producerConsumer } from '@/testing/ctfSynth'

const run = vi.hoisted(() => ({ available: true, paused: false, pause: vi.fn() }))
vi.mock('@/debug/control', () => ({
  getSnapshot: () => ({ available: run.available, paused: run.paused }),
  pause: run.pause,
}))

const bytes = producerConsumer(200)
/** Each record's end offset and timestamp, as a whole-stream decode sees them. */
const index = (() => {
  const reader = new TraceReader(fallbackDefs())
  const ends: number[] = []
  const times: number[] = []
  reader.onRecord = (end, ts) => {
    ends.push(end)
    times.push(ts)
  }
  reader.feed(bytes)
  return { ends, times }
})()

/** Live up to just past record `k` (3 bytes into the next), then record the rest. */
function recordFrom(k: number, chunk = 997): recorder.TraceRecording {
  const startAt = index.ends[k]! + 3
  hostTrace.debugFeed(bytes.subarray(0, startAt))
  expect(recorder.start()).toBe(true)
  for (let off = startAt; off < bytes.length; off += chunk) {
    hostTrace.debugFeed(bytes.subarray(off, Math.min(bytes.length, off + chunk)))
  }
  recorder.stop()
  return recorder.getSnapshot().last!
}

/** The whole stream decoded up to guest time `ts`, held there. */
function decodedUntil(ts: number): Trace {
  const reader = new TraceReader(fallbackDefs())
  const n = index.times.filter((t) => t <= ts).length
  reader.feed(bytes.subarray(0, index.ends[n - 1]))
  reader.extendTo(ts)
  return reader.tr
}

function clip(segs: readonly StateSeg[], from: number): StateSeg[] {
  return segs.filter((seg) => seg[1] > from).map(([s, ...rest]) => [Math.max(s, from), ...rest] as StateSeg)
}

/** The replay's trace matches the live decode at `ts`, from where recording began. */
function expectSameAs(replay: TraceReplay, ts: number) {
  const tr = replay.getSnapshot().trace.trace!
  const ref = decodedUntil(ts)
  const from = replay.startTs
  expect(tr.t0).toBe(from)
  expect(tr.t1).toBe(ts)
  expect(tr.events).toEqual(ref.events.filter((e) => e.ts > from))
  // At the fork point itself both hold zero-length states: compare what follows.
  for (const [tid, segs] of ref.states) {
    expect(clip(tr.states.get(tid) ?? [], from), `thread 0x${tid.toString(16)}`).toEqual(clip(segs, from))
  }
}

beforeEach(() => {
  run.pause.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
})

afterEach(() => {
  recorder.reset()
  hostTrace.detach()
  vi.useRealTimers()
})

describe('a Trace recording', () => {
  it('keeps every byte from where the live decoder stood, and opens its replay', () => {
    const k = 500
    const rec = recordFrom(k)

    expect(rec.bytes).toEqual(bytes.subarray(index.ends[k]!))
    expect(rec.events).toBe(index.ends.length - k - 1)
    expect(rec.reason).toBe('stopped')
    expect(recorder.getSnapshot()).toMatchObject({ recording: false, replayOpen: true })
    // The live panel saw everything, recording or not.
    expect(hostTrace.getSnapshot().trace?.events).toHaveLength(index.ends.length)
  })

  it('pauses the guest when it stops, and says so', () => {
    expect(recordFrom(500).pausedGuest).toBe(true)
    expect(run.pause).toHaveBeenCalledTimes(1)
  })

  it('leaves the guest running when there is nothing to replay', () => {
    hostTrace.debugFeed(bytes.subarray(0, index.ends[100]))
    recorder.start()
    recorder.stop()

    expect(recorder.getSnapshot()).toMatchObject({ replayOpen: false, last: { events: 0, pausedGuest: false } })
    expect(run.pause).not.toHaveBeenCalled()
  })

  it('cannot start before there is a stream', () => {
    expect(recorder.start()).toBe(false)
    expect(recorder.getSnapshot().recording).toBe(false)
  })

  it('ends with the stream, and waits to be opened', () => {
    hostTrace.debugFeed(bytes.subarray(0, index.ends[100]))
    recorder.start()
    hostTrace.debugFeed(bytes.subarray(index.ends[100], index.ends[200]))
    hostTrace.detach()

    const snap = recorder.getSnapshot()
    expect(snap.last).toMatchObject({ reason: 'ended', events: 100, pausedGuest: false })
    expect(snap.replayOpen).toBe(false)
    expect(run.pause).not.toHaveBeenCalled()
    recorder.openReplay()
    expect(recorder.getSnapshot().replayOpen).toBe(true)
  })

  it('replaces the last one when a new one starts', () => {
    recordFrom(100)
    expect(recorder.getSnapshot().last).not.toBeNull()
    hostTrace.debugFeed(Uint8Array.from([]))
    recorder.start()
    expect(recorder.getSnapshot()).toMatchObject({ recording: true, last: null, replayOpen: false })
  })
})

describe('a Trace replay', () => {
  it('opens at the end of the recording, as the live panel stood', () => {
    const replay = new TraceReplay(recordFrom(500))
    const snap = replay.getSnapshot()

    expect(replay.startTs).toBe(index.times[500])
    expect(snap.cursor).toBe(index.times.at(-1))
    expect(snap.position).toBe(snap.total)
    expectSameAs(replay, snap.cursor)
  })

  it('shows any moment as the live decoder did, going forward or back', () => {
    const replay = new TraceReplay(recordFrom(500))
    const { startTs, endTs } = replay
    const at = (f: number) => Math.round(startTs + (endTs - startTs) * f)

    for (const f of [0.5, 0.2, 0.2001, 0.9, 0, 0.35]) {
      replay.seek(at(f))
      expectSameAs(replay, at(f))
    }
  })

  it('plays at the chosen speed, and stops at the end', () => {
    const replay = new TraceReplay(recordFrom(500))
    replay.seek(replay.startTs)
    replay.setSpeed(0.001)
    replay.play()
    vi.advanceTimersByTime(1_000)

    // A wall-clock second at 0.001× is a millisecond of guest time.
    const snap = replay.getSnapshot()
    expect(snap.playing).toBe(true)
    expect(snap.cursor).toBe(replay.startTs + 1_000_000)
    expectSameAs(replay, snap.cursor)

    vi.advanceTimersByTime(10_000)
    expect(replay.getSnapshot()).toMatchObject({ playing: false, cursor: replay.endTs })
  })

  it('plays again from the start once at the end', () => {
    const replay = new TraceReplay(recordFrom(500))
    replay.play()
    expect(replay.getSnapshot()).toMatchObject({ playing: true, cursor: replay.startTs })
  })

  it('steps from one recorded event to the next', () => {
    const replay = new TraceReplay(recordFrom(500))
    replay.seek(replay.startTs)
    replay.step(1)
    expect(replay.getSnapshot().cursor).toBe(index.times[501])
    replay.step(1)
    expect(replay.getSnapshot().cursor).toBe(index.times[502])
    replay.step(-1)
    expect(replay.getSnapshot().cursor).toBe(index.times[501])
  })
})
