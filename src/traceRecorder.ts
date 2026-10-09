/**
 * Record the Trace stream, to replay it later with the guest paused.
 *
 * The live Trace keeps only the newest 50k events, because every view rebuilds
 * from that log on each publication (see MAX_EVENTS in hostTrace.ts). A
 * recording sidesteps that by keeping the raw CTF instead: about 25 bytes an
 * event against 200 decoded, and nothing to decode while the guest runs, so
 * recording costs the guest a memcpy per poll. The decoding happens in
 * tracePlayback.ts, once the recording stops and the guest is paused.
 *
 * It starts from a fork of the live decoder (TraceReader.fork), so the replay
 * knows every thread's name, priority and state from its first frame rather
 * than learning them as each one next switches in.
 */

import * as debug from '@/debug/control'
import {
  closeTap,
  getSnapshot as getTraceSnapshot,
  openTap,
  type TraceSource,
  type TraceTap,
} from '@/hostTrace'
import type { TraceReader } from '@/ctf'

/**
 * Stop by itself here. Opening the replay decodes the whole recording once,
 * which takes a second or two at this size; seeks after that start from the
 * nearest checkpoint (tracePlayback.ts), so they stay quick however long it
 * is. It is also ~25 MB of CTF.
 */
export const MAX_RECORDED_EVENTS = 1_000_000
/** Belt and braces for a stream of unusually large records. */
const MAX_RECORDED_BYTES = 64 * 1024 * 1024
/** How often the recording indicator refreshes while nothing else changes. */
const TICK_MS = 500

export interface TraceRecording {
  /** The decoder as the live one stood when recording began. Fork it; never feed it. */
  origin: TraceReader
  /** Every byte the live decoder was fed while recording, record-aligned. */
  bytes: Uint8Array
  /** Events the live decoder counted in those bytes. */
  events: number
  source: TraceSource
  /** Why it ended: the Stop button, the size limit, or the stream going away. */
  reason: 'stopped' | 'limit' | 'ended'
  /** Whether stopping it paused the guest, so the replay can offer to resume. */
  pausedGuest: boolean
}

export interface RecorderSnapshot {
  recording: boolean
  /** Events and bytes so far, while recording. */
  events: number
  bytes: number
  /** Guest time covered so far, while recording. */
  spanNs: number
  /** The last finished recording, kept until the next one starts. */
  last: TraceRecording | null
  /** Whether the replay dialog is showing `last`. */
  replayOpen: boolean
}

const IDLE: RecorderSnapshot = {
  recording: false,
  events: 0,
  bytes: 0,
  spanNs: 0,
  last: null,
  replayOpen: false,
}

interface Active {
  tap: TraceTap
  origin: TraceReader
  source: TraceSource
  startTs: number
  chunks: Uint8Array[]
  events: number
  bytes: number
  timer: ReturnType<typeof setInterval>
}

let snapshot: RecorderSnapshot = IDLE
let active: Active | null = null
const listeners = new Set<() => void>()

function emit(next: Partial<RecorderSnapshot>) {
  snapshot = { ...snapshot, ...next }
  for (const fn of listeners) fn()
}

function progress() {
  if (!active) return
  const t1 = getTraceSnapshot().trace?.t1 ?? active.startTs
  emit({
    events: active.events,
    bytes: active.bytes,
    spanNs: Math.max(0, t1 - active.startTs),
  })
}

function finish(reason: TraceRecording['reason']) {
  const rec = active
  if (!rec) return
  active = null
  clearInterval(rec.timer)
  closeTap(rec.tap)

  const bytes = new Uint8Array(rec.bytes)
  let off = 0
  for (const chunk of rec.chunks) {
    bytes.set(chunk, off)
    off += chunk.length
  }
  // Popping a replay over the next sample would be a surprise: one whose
  // stream ended waits for the Replay button instead. One with nothing in it
  // has nothing to open.
  const opens = reason !== 'ended' && rec.events > 0
  // The guest stops where the replay does, so the two agree on what happened
  // last. A board on the bridge has no such switch.
  const run = debug.getSnapshot()
  const pausedGuest = opens && rec.source === 'guest' && run.available && !run.paused
  if (pausedGuest) debug.pause()

  emit({
    recording: false,
    events: 0,
    bytes: 0,
    spanNs: 0,
    last: {
      origin: rec.origin,
      bytes,
      events: rec.events,
      source: rec.source,
      reason,
      pausedGuest,
    },
    replayOpen: opens,
  })
}

/** Start recording the live Trace. False when there is no stream to record yet. */
export function start(): boolean {
  if (active) return true
  const tap: TraceTap = {
    bytes(chunk, events) {
      const rec = active
      if (!rec || rec.tap !== tap) return
      rec.chunks.push(chunk.slice())
      rec.bytes += chunk.length
      rec.events += events
      if (rec.events >= MAX_RECORDED_EVENTS || rec.bytes >= MAX_RECORDED_BYTES) finish('limit')
    },
    end() {
      if (active?.tap === tap) finish('ended')
    },
  }
  const from = openTap(tap)
  if (!from) return false
  const chunks = from.pending.length ? [from.pending] : []
  active = {
    tap,
    origin: from.origin,
    source: from.source,
    startTs: from.origin.tr.t1,
    chunks,
    events: 0,
    bytes: from.pending.length,
    timer: setInterval(progress, TICK_MS),
  }
  // A new recording replaces the last one, and its replay with it.
  emit({ recording: true, events: 0, bytes: active.bytes, spanNs: 0, last: null, replayOpen: false })
  return true
}

/** Stop recording, pause the guest and open the replay. */
export function stop() {
  finish('stopped')
}

export function openReplay() {
  if (snapshot.last && snapshot.last.events > 0) emit({ replayOpen: true })
}

export function closeReplay() {
  if (snapshot.replayOpen) emit({ replayOpen: false })
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): RecorderSnapshot {
  return snapshot
}

/** Test helper: drop any recording and its state. */
export function reset() {
  if (active) {
    clearInterval(active.timer)
    closeTap(active.tap)
    active = null
  }
  snapshot = IDLE
}
