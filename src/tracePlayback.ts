/**
 * Replay a Trace recording through the same decoder the live panel uses.
 *
 * A replay is the live stream again, at a pace the reader picks: it feeds the
 * recorded CTF to a fork of the decoder up to the playback cursor, so every
 * tab (Timeline, IPC, zbus, Networking, Power) draws exactly what it drew
 * live, packets on the IPC graph included, and with the same 50k event log.
 * Between records the trace's newest time is held at the cursor
 * (TraceReader.extendTo), so the timeline scrolls at the playback rate
 * instead of hopping from one event to the next.
 *
 * Forward is incremental. Back means decoding again from the start of the
 * recording, at about a million events a second: recordings stop at
 * MAX_RECORDED_EVENTS to keep that under a second.
 */

import { MAX_EVENTS, trimEventLog, type TraceSnapshot } from '@/hostTrace'
import type { TraceReader } from '@/ctf'
import type { TraceRecording } from '@/traceRecorder'

/** Decode this much between event-log trims, about 10k events. */
const FEED_CHUNK = 256 * 1024
/** Publication cadence while playing: smooth enough to watch the Timeline scroll. */
const TICK_MS = 100
/** The IPC graph's packets are timed for the live 200 ms detail cadence. */
const DETAIL_TICK_MS = 200

/** Guest time per wall-clock time. Scheduling happens in microseconds, so mostly slower. */
export const REPLAY_SPEEDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2] as const

export interface ReplaySnapshot {
  startTs: number
  endTs: number
  /** Guest time the replay shows, in [startTs, endTs]. */
  cursor: number
  playing: boolean
  speed: number
  /** Recorded events at or before the cursor. */
  position: number
  total: number
  /** What the Trace views draw: shaped like the live one. */
  trace: TraceSnapshot
}

/** First index whose value is greater than `x`. */
function upperBound(arr: Float64Array, x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class TraceReplay {
  readonly startTs: number
  readonly endTs: number
  readonly total: number
  private readonly rec: TraceRecording
  /** Each decoded record's timestamp, in stream order. */
  private readonly times: Float64Array
  /** The byte offset just past each record, parallel to `times`. */
  private readonly ends: Float64Array
  private reader: TraceReader
  /** Bytes of the recording the reader has been given. */
  private fed: number
  private cursor: number
  private playing = false
  private speed = 1
  private revision = 0
  private detailLeases = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastTick = 0
  private snap: ReplaySnapshot
  private readonly listeners = new Set<() => void>()

  constructor(rec: TraceRecording) {
    this.rec = rec
    // One pass builds the index from time to bytes and leaves the reader at
    // the end of the recording, where the replay opens: on the same moment
    // the live panel showed when recording stopped.
    const reader = rec.origin.fork()
    const times: number[] = []
    const ends: number[] = []
    reader.onRecord = (end, ts) => {
      times.push(ts)
      ends.push(end)
    }
    for (let off = 0; off < rec.bytes.length; off += FEED_CHUNK) {
      reader.feed(rec.bytes.subarray(off, off + FEED_CHUNK))
      trimEventLog(reader.tr)
    }
    reader.onRecord = null
    this.reader = reader
    this.times = Float64Array.from(times)
    this.ends = Float64Array.from(ends)
    this.total = times.length
    // A trailing partial record stays in the reader, never to be completed.
    this.fed = ends.at(-1) ?? 0
    this.startTs = rec.origin.forkedAt ?? times[0] ?? 0
    this.endTs = Math.max(this.startTs, times.at(-1) ?? this.startTs)
    this.cursor = this.endTs
    this.snap = this.build()
  }

  /** Show the trace as it stood at guest time `ts`. */
  seek(ts: number) {
    const target = Math.min(this.endTs, Math.max(this.startTs, ts))
    this.moveTo(target)
    this.publish()
  }

  /** Jump to the next recorded event after the cursor (+1), or the one before it (-1). */
  step(direction: 1 | -1) {
    if (direction > 0) {
      const i = upperBound(this.times, this.cursor)
      this.seek(i < this.total ? this.times[i]! : this.endTs)
      return
    }
    // The last event strictly before the cursor.
    let lo = 0
    let hi = this.total
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.times[mid]! < this.cursor) lo = mid + 1
      else hi = mid
    }
    this.seek(lo > 0 ? this.times[lo - 1]! : this.startTs)
  }

  play() {
    if (this.playing) return
    // Play from the end means play it again.
    if (this.cursor >= this.endTs) this.moveTo(this.startTs)
    this.playing = true
    this.lastTick = performance.now()
    this.schedule()
    this.publish()
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.publish()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  setSpeed(speed: number) {
    if (!(speed > 0) || speed === this.speed) return
    this.speed = speed
    this.publish()
  }

  /**
   * Publish at the IPC graph's slower cadence while it is open, as the live
   * panel does (hostTrace.requestDetailUpdates).
   */
  requestDetailUpdates = (): (() => void) => {
    this.detailLeases++
    let active = true
    return () => {
      if (!active) return
      active = false
      this.detailLeases = Math.max(0, this.detailLeases - 1)
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): ReplaySnapshot => this.snap

  dispose() {
    this.pause()
    this.listeners.clear()
  }

  private schedule() {
    this.timer = setTimeout(this.tick, this.detailLeases > 0 ? DETAIL_TICK_MS : TICK_MS)
  }

  private tick = () => {
    this.timer = undefined
    if (!this.playing) return
    const now = performance.now()
    // Wall time actually elapsed, so a slow repaint does not slow the replay.
    const next = this.cursor + (now - this.lastTick) * 1e6 * this.speed
    this.lastTick = now
    if (next >= this.endTs) {
      this.moveTo(this.endTs)
      this.playing = false
    } else {
      this.moveTo(next)
      this.schedule()
    }
    this.publish()
  }

  private moveTo(ts: number) {
    const n = upperBound(this.times, ts)
    const byte = n > 0 ? this.ends[n - 1]! : 0
    // Decoding only goes forward: a cursor before the newest decoded record
    // starts over from the fork. Within the gap after it, extendTo moves the
    // held time either way.
    if (byte < this.fed) {
      this.reader = this.rec.origin.fork()
      this.fed = 0
    }
    while (this.fed < byte) {
      const end = Math.min(byte, this.fed + FEED_CHUNK)
      this.reader.feed(this.rec.bytes.subarray(this.fed, end))
      this.fed = end
      trimEventLog(this.reader.tr)
    }
    this.reader.extendTo(ts)
    this.cursor = ts
  }

  /** Recorded events the reader has decoded. */
  private position(): number {
    return upperBound(this.ends, this.fed)
  }

  private build(): ReplaySnapshot {
    const tr = this.reader.tr
    return {
      startTs: this.startTs,
      endTs: this.endTs,
      cursor: this.cursor,
      playing: this.playing,
      speed: this.speed,
      position: this.position(),
      total: this.total,
      trace: {
        available: true,
        following: true,
        revision: this.revision,
        eventCount: Math.min(tr.events.length, MAX_EVENTS),
        threadCount: tr.threads.size,
        desync: this.reader.desync,
        spanNs: tr.t1 - tr.t0,
        trace: tr,
        path: null,
        source: this.rec.source,
      },
    }
  }

  private publish() {
    this.revision++
    this.snap = this.build()
    for (const fn of this.listeners) fn()
  }
}
