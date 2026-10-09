/**
 * Browser end of Zephyr's semihosting CTF backend.
 *
 * The guest opens `./tracing.bin` via ARM semihosting and appends CTF records
 * as events fire (see subsys/tracing/tracing_backend_semihosting.c). Under
 * qemu-wasm those writes land in Emscripten's MEMFS; this module polls the
 * file, feeds new bytes into a TraceReader, and notifies subscribers — the
 * same follow mode trace_viewer.py gets from watching a growing file.
 *
 * Hidden until the file appears (or we have events), so a shell session never
 * shows an empty Trace panel.
 */

import {
  dropOldestEvents,
  fallbackDefs,
  loadEventDefs,
  TraceReader,
  type EventDef,
  type Trace,
} from '@/ctf'
import { register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'

const TRACE_PATHS = ['./tracing.bin', '/tracing.bin', 'tracing.bin']
/**
 * The page's own copy of Zephyr's TSDL, for a guest that ships no table of its
 * own: an image from before tools/build-zephyr-image.sh shipped one, a dropped
 * ELF, or a live board.
 */
const METADATA_URL = `${import.meta.env.BASE_URL}tracing/metadata`
const POLL_ID = 'trace'
const POLL_MS = 250
/** Queue synoptics opt into this cadence only while their tab is mounted. */
const DETAIL_POLL_MS = 200
/** Rendering a high-rate trace faster than this is not perceptibly smoother. */
const UI_UPDATE_MS = 500
const DETAIL_UI_UPDATE_MS = 200
/**
 * Cap retained events so a long-running sample cannot unbounded-grow the heap.
 *
 * The heap is the smaller half of it: a decoded event is about 200 bytes, so
 * 50k is ~10 MB. The larger half is time. The IPC graph, the queue lanes and
 * the depth, sync, network and zbus views are rebuilt from the whole log on
 * every publication, and on the browser main thread, where the guest's own
 * semihost writes are proxied too. That rebuild is ~60 ms at 50k and several
 * hundred at 500k, so a bigger live log makes both the page and the guest
 * stutter. A longer look is what traceRecorder.ts is for: it keeps the raw CTF
 * (~25 bytes an event) and decodes it only to replay, with the guest paused.
 */
export const MAX_EVENTS = 50_000
/** Trim in batches instead of allocating a 50k-element copy every poll. */
const TRIM_BATCH = 5_000

/**
 * Drop the oldest events once the log is a batch past {@link MAX_EVENTS}.
 *
 * Only the event log needs an exact cap. State timelines are indexed for live
 * drawing, and rebuilding them from a truncated CTF stream would be both slower
 * and less accurate. Batching the splice avoids a 50k copy on every high-rate
 * poll. What the dropped events did to queue depths is kept (Trace.queueBase).
 */
export function trimEventLog(tr: Trace) {
  if (tr.events.length > MAX_EVENTS + TRIM_BATCH) {
    dropOldestEvents(tr, tr.events.length - MAX_EVENTS)
  }
}

/**
 * Sees every byte the live decoder is fed, from the moment it is opened. A
 * recording is one; see traceRecorder.ts.
 */
export interface TraceTap {
  /** `chunk` is only valid during the call: copy what you keep. */
  bytes(chunk: Uint8Array, events: number): void
  /** The decoder went away (a new guest, the board stream ended); no more bytes. */
  end(): void
}

/** Where a tap's bytes carry on from. */
export interface TraceTapStart {
  /** A decoder positioned where the live one was when the tap opened: never feed it. */
  origin: TraceReader
  /** The start of a record the live decoder was still waiting on: the tap's first bytes. */
  pending: Uint8Array
  source: TraceSource
}

interface EmscriptenFS {
  analyzePath?: (path: string) => { exists: boolean; object?: { contents?: Uint8Array; usedBytes?: number } }
  readFile?: (path: string, opts?: { encoding: 'binary' }) => Uint8Array
  stat?: (path: string) => { size: number }
}

interface TraceModule {
  FS?: EmscriptenFS
}

export type TraceSource = 'guest' | 'probe' | 'bridge' | null

export interface TraceSnapshot {
  available: boolean
  /** True once /tracing.bin has been seen, even before the first full record. */
  following: boolean
  /** Monotonic change token; continues after the retained-event cap is reached. */
  revision: number
  eventCount: number
  threadCount: number
  desync: boolean
  /** Nanoseconds of decoded span, or 0. */
  spanNs: number
  trace: Trace | null
  path: string | null
  /** Where CTF bytes currently come from (guest semihost file vs probe bridge). */
  source: TraceSource
}

const EMPTY: TraceSnapshot = {
  available: false,
  following: false,
  revision: 0,
  eventCount: 0,
  threadCount: 0,
  desync: false,
  spanNs: 0,
  trace: null,
  path: null,
  source: null,
}

let mod: TraceModule | null = null
let reader: TraceReader | null = null
let offset = 0
let path: string | null = null
let snapshot: TraceSnapshot = EMPTY
/** The page's own table: what a live board, or a guest that ships none, decodes with. */
let defsReady: Promise<void> | null = null
let defs = fallbackDefs()
/** The table shipped beside the running image, tried before METADATA_URL. */
let guestTableUrl: string | null = null
let guestDefsReady: Promise<Map<number, EventDef>> | null = null
let revision = 0
let lastPublishAt = 0
let publishTimer: ReturnType<typeof setTimeout> | undefined
let detailUpdateLeases = 0
/** When set, CTF comes from the probe bridge instead of the guest FS. */
let externalLabel: string | null = null
let tap: TraceTap | null = null
const listeners = new Set<() => void>()

function pollMs(): number {
  return detailUpdateLeases > 0 ? DETAIL_POLL_MS : POLL_MS
}

function uiUpdateMs(): number {
  return detailUpdateLeases > 0 ? DETAIL_UI_UPDATE_MS : UI_UPDATE_MS
}

function notify() {
  for (const fn of listeners) fn()
}

function currentSource(): TraceSource {
  if (externalLabel === 'bridge') return 'bridge'
  if (externalLabel) return 'probe'
  if (path) return 'guest'
  return null
}

function publish() {
  if (!reader) {
    snapshot = path || externalLabel
      ? {
          ...EMPTY,
          following: true,
          path: path ?? externalLabel,
          available: true,
          source: currentSource(),
        }
      : EMPTY
    notify()
    return
  }
  const tr = reader.tr
  // Drop oldest events if the guest runs forever — keep the live edge useful.
  trimEventLog(tr)
  snapshot = {
    available: tr.events.length > 0 || path !== null || externalLabel !== null,
    following: path !== null || externalLabel !== null,
    revision,
    // The log may briefly exceed the cap between batch trims; present the
    // stable retention limit rather than a noisy 50k→55k counter.
    eventCount: Math.min(tr.events.length, MAX_EVENTS),
    threadCount: tr.threads.size,
    desync: reader.desync,
    spanNs: tr.events.length ? tr.t1 - tr.t0 : 0,
    trace: tr,
    path: path ?? externalLabel,
    source: currentSource(),
  }
  notify()
}

/** Coalesce high-rate decoder updates into a steady, inexpensive UI cadence. */
function requestPublish() {
  const updateMs = uiUpdateMs()
  const elapsed = performance.now() - lastPublishAt
  if (elapsed >= updateMs) {
    revision++
    lastPublishAt = performance.now()
    publish()
    return
  }
  if (publishTimer !== undefined) return
  publishTimer = setTimeout(() => {
    publishTimer = undefined
    revision++
    lastPublishAt = performance.now()
    publish()
  }, updateMs - elapsed)
}

/** Decode `chunk` live, and hand it to an open tap. Returns the new event count. */
function feed(chunk: Uint8Array): number {
  const n = reader!.feed(chunk)
  tap?.bytes(chunk, n)
  return n
}

/** The live decoder is being replaced: whatever was tapping it has ended. */
function endTap() {
  const t = tap
  tap = null
  t?.end()
}

function findTraceFile(fs: EmscriptenFS): string | null {
  for (const candidate of TRACE_PATHS) {
    try {
      if (fs.stat) {
        const st = fs.stat(candidate)
        if (st && st.size >= 0) return candidate
      } else if (fs.analyzePath) {
        const info = fs.analyzePath(candidate)
        if (info.exists) return candidate
      } else if (fs.readFile) {
        fs.readFile(candidate, { encoding: 'binary' })
        return candidate
      }
    } catch {
      /* try next */
    }
  }
  return null
}

function readNewBytes(fs: EmscriptenFS, filePath: string): Uint8Array | null {
  try {
    // Prefer a view into MEMFS so a 200 ms poll does not copy the whole file
    // every tick. TraceReader.feed() copies into its own buffer immediately.
    if (fs.analyzePath) {
      const info = fs.analyzePath(filePath)
      const contents = info.object?.contents
      if (contents) {
        const length = info.object?.usedBytes ?? contents.length
        if (length <= offset) return null
        const chunk = contents.subarray(offset, length)
        offset = length
        return chunk
      }
    }
    if (!fs.readFile) return null
    const all = fs.readFile(filePath, { encoding: 'binary' })
    if (!all || all.length <= offset) return null
    const chunk = all.subarray(offset)
    offset = all.length
    return chunk
  } catch {
    return null
  }
}

async function ensureDefs() {
  if (!defsReady) {
    defsReady = loadEventDefs([METADATA_URL]).then((d) => {
      defs = d
    })
  }
  await defsReady
}

/**
 * The table to decode the attached guest with: the image's own first. CTF ids
 * are positional and Zephyr renumbers them, so only the table an image was built
 * with is sure to match it, while the page's copy matches only the Zephyr it was
 * last refreshed from. Kept apart from `defs`, which a live board decodes with:
 * an image's table describes that image and nothing else.
 */
function loadGuestDefs(): Promise<Map<number, EventDef>> {
  guestDefsReady ??= guestTableUrl
    ? loadEventDefs([guestTableUrl, METADATA_URL])
    : ensureDefs().then(() => defs)
  return guestDefsReady
}

function sample() {
  // Probe bridge owns the decoder while connected.
  if (externalLabel) return

  const fs = mod?.FS
  if (!fs) return

  if (!path) {
    path = findTraceFile(fs)
    if (!path) return
    // File appeared — make sure defs are loaded before we decode.
    const pending = loadGuestDefs()
    void pending.then((guestDefs) => {
      // A guest attached since then brought a table of its own.
      if (pending !== guestDefsReady) return
      if (!reader) reader = new TraceReader(guestDefs)
      publish()
    })
  }

  if (!reader) {
    // Defs still loading; remember the path so the panel can show "waiting".
    publish()
    return
  }

  const chunk = readNewBytes(fs, path!)
  if (chunk && chunk.length) {
    if (feed(chunk) > 0) {
      // eventCount is capped, so revision is the live UI signal. Coalescing
      // it prevents a busy tracing sample from repainting React and canvas for
      // every filesystem poll.
      requestPublish()
    }
  } else if (snapshot.path !== path) {
    publish()
  }
}

/**
 * Follow a booted guest's trace file.
 *
 * @param tableUrl - the CTF table its image shipped with, or null when it has
 *   none. Fetched only once the guest actually writes a trace, so an untraced
 *   image never asks for a table it does not have.
 */
export function attach(instance: unknown, tableUrl: string | null = null) {
  detach()
  mod = instance as TraceModule
  if (tableUrl !== guestTableUrl) {
    guestTableUrl = tableUrl
    guestDefsReady = null
  }
  sample()
  registerPoll(POLL_ID, pollMs(), sample)
}

export function detach() {
  unregisterPoll(POLL_ID)
  mod = null
  // Keep an external (probe) session across guest detach/reattach.
  if (!externalLabel) {
    endTap()
    reader = null
    offset = 0
    path = null
    revision = 0
    lastPublishAt = 0
    if (publishTimer !== undefined) clearTimeout(publishTimer)
    publishTimer = undefined
    if (snapshot !== EMPTY) {
      snapshot = EMPTY
      notify()
    }
  } else {
    path = null
    offset = 0
  }
}

/**
 * Switch the Trace decoder to an external CTF byte source (probe bridge).
 * Resets retained events so a new board session starts clean.
 */
export function beginExternal(label = 'probe') {
  endTap()
  externalLabel = label
  path = null
  offset = 0
  reader = new TraceReader(defs, true, true)
  revision++
  lastPublishAt = performance.now()
  publish()
  void ensureDefs().then(() => {
    // Swap in loaded metadata without dropping already-fed events unless the
    // reader is still empty (defs arrived before any CTF).
    if (externalLabel !== label) return
    if (!reader || reader.tr.events.length === 0) {
      endTap()
      reader = new TraceReader(defs, true, true)
      publish()
    }
  })
}

/** Append CTF bytes from the probe bridge. */
export function feedExternal(bytes: Uint8Array) {
  if (!externalLabel) beginExternal('probe')
  if (!reader) {
    reader = new TraceReader(defs, true, true)
  }
  if (bytes.length && feed(bytes) > 0) {
    requestPublish()
  } else if (!snapshot.available) {
    publish()
  }
}

/** Leave probe mode; guest FS polling can resume on the next sample(). */
export function endExternal() {
  if (!externalLabel) return
  endTap()
  externalLabel = null
  reader = null
  revision = 0
  lastPublishAt = 0
  if (publishTimer !== undefined) {
    clearTimeout(publishTimer)
    publishTimer = undefined
  }
  // If a guest file is still attached, the next poll rebuilds; otherwise clear.
  if (!mod) {
    path = null
    snapshot = EMPTY
    notify()
  } else {
    path = null
    offset = 0
    publish()
  }
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Hand every byte the live decoder is fed from now on to `next`, until
 * {@link closeTap} or the decoder goes away. Null with no decoder yet to tap.
 * One tap at a time: opening another ends the first.
 */
export function openTap(next: TraceTap): TraceTapStart | null {
  if (!reader) return null
  endTap()
  tap = next
  return { origin: reader.fork(), pending: reader.pendingBytes, source: currentSource() }
}

/** Stop handing bytes to `t`, without telling it. A no-op once another tap has opened. */
export function closeTap(t: TraceTap) {
  if (tap === t) tap = null
}

export function getSnapshot(): TraceSnapshot {
  return snapshot
}

/**
 * Temporarily follow CTF at 5 Hz for detail views that need to expose short
 * within-batch transitions. The normal 2 Hz publication remains the default,
 * so hidden/collapsed trace panels do not pay for the extra reconstruction.
 */
export function requestDetailUpdates(): () => void {
  detailUpdateLeases++
  if (detailUpdateLeases === 1) {
    if (mod) registerPoll(POLL_ID, pollMs(), sample)
    // A slower pending publication may already hold freshly decoded events.
    if (publishTimer !== undefined) {
      clearTimeout(publishTimer)
      publishTimer = undefined
      requestPublish()
    }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    detailUpdateLeases = Math.max(0, detailUpdateLeases - 1)
    if (detailUpdateLeases === 0 && mod) registerPoll(POLL_ID, pollMs(), sample)
  }
}

/** Test helper: push synthetic CTF bytes as if the guest wrote them. */
export function debugFeed(bytes: Uint8Array) {
  if (!reader) reader = new TraceReader(defs)
  path = path ?? './tracing.bin'
  // Keep the test/demo hook synchronous; only the real filesystem follower
  // needs UI coalescing.
  if (feed(bytes) > 0) {
    revision++
    lastPublishAt = performance.now()
  }
  publish()
}

// Dev-only hook so screenshot / manual demos can inject a synthetic CTF stream
// without a qemu-wasm build. Production builds tree-shake this away via DEV.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __zephyrTraceDebugFeed?: typeof debugFeed }).__zephyrTraceDebugFeed =
    debugFeed
}
