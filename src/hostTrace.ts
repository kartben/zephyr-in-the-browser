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

import { fallbackDefs, loadEventDefs, TraceReader, type Trace } from '@/ctf'
import { register as registerPoll, unregister as unregisterPoll } from '@/hostPoll'

const TRACE_PATHS = ['./tracing.bin', '/tracing.bin', 'tracing.bin']
const METADATA_URL = `${import.meta.env.BASE_URL}tracing/metadata`
const POLL_ID = 'trace'
const POLL_MS = 250
/** Rendering a high-rate trace faster than this is not perceptibly smoother. */
const UI_UPDATE_MS = 500
/** Cap retained events so a long-running sample cannot unbounded-grow the heap. */
const MAX_EVENTS = 50_000
/** Trim in batches instead of allocating a 50k-element copy every poll. */
const TRIM_BATCH = 5_000

interface EmscriptenFS {
  analyzePath?: (path: string) => { exists: boolean; object?: { contents?: Uint8Array; usedBytes?: number } }
  readFile?: (path: string, opts?: { encoding: 'binary' }) => Uint8Array
  stat?: (path: string) => { size: number }
}

interface TraceModule {
  FS?: EmscriptenFS
}

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
}

let mod: TraceModule | null = null
let reader: TraceReader | null = null
let offset = 0
let path: string | null = null
let snapshot: TraceSnapshot = EMPTY
let defsReady: Promise<void> | null = null
let defs = fallbackDefs()
let revision = 0
let lastPublishAt = 0
let publishTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish() {
  if (!reader) {
    snapshot = path
      ? { ...EMPTY, following: true, path, available: true, trace: null }
      : EMPTY
    notify()
    return
  }
  const tr = reader.tr
  // Drop oldest events if the guest runs forever — keep the live edge useful.
  if (tr.events.length > MAX_EVENTS + TRIM_BATCH) {
    // Only the event log needs an exact cap. State timelines are indexed for
    // live drawing, and rebuilding them from a truncated CTF stream would be
    // both slower and less accurate. Batch the splice to avoid a 50k copy on
    // every high-rate poll.
    tr.events.splice(0, tr.events.length - MAX_EVENTS)
  }
  snapshot = {
    available: tr.events.length > 0 || path !== null,
    following: path !== null,
    revision,
    // The log may briefly exceed the cap between batch trims; present the
    // stable retention limit rather than a noisy 50k→55k counter.
    eventCount: Math.min(tr.events.length, MAX_EVENTS),
    threadCount: tr.threads.size,
    desync: reader.desync,
    spanNs: tr.events.length ? tr.t1 - tr.t0 : 0,
    trace: tr,
    path,
  }
  notify()
}

/** Coalesce high-rate decoder updates into a steady, inexpensive UI cadence. */
function requestPublish() {
  const elapsed = performance.now() - lastPublishAt
  if (elapsed >= UI_UPDATE_MS) {
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
  }, UI_UPDATE_MS - elapsed)
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
    defsReady = loadEventDefs(METADATA_URL).then((d) => {
      defs = d
    })
  }
  await defsReady
}

function sample() {
  const fs = mod?.FS
  if (!fs) return

  if (!path) {
    path = findTraceFile(fs)
    if (!path) return
    // File appeared — make sure defs are loaded before we decode.
    void ensureDefs().then(() => {
      if (!reader) reader = new TraceReader(defs)
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
    if (reader.feed(chunk) > 0) {
      // eventCount is capped, so revision is the live UI signal. Coalescing
      // it prevents a busy tracing sample from repainting React and canvas for
      // every filesystem poll.
      requestPublish()
    }
  } else if (snapshot.path !== path) {
    publish()
  }
}

export function attach(instance: unknown) {
  detach()
  mod = instance as TraceModule
  void ensureDefs()
  sample()
  registerPoll(POLL_ID, POLL_MS, sample)
}

export function detach() {
  unregisterPoll(POLL_ID)
  mod = null
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
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): TraceSnapshot {
  return snapshot
}

/**
 * Map a host `performance.now()` stamp onto approximate guest CTF ns using the
 * last Trace publish as an anchor (`tr.t1` at `lastPublishAt`). Valid only while
 * the decoder is following and roughly live — icount stalls make this drift.
 * Returns null when there is no trace to anchor against.
 */
export function guestNsApproxFromHostMs(hostMs: number): number | null {
  const tr = snapshot.trace
  if (!tr || tr.events.length === 0 || lastPublishAt <= 0) return null
  return tr.t1 + (hostMs - lastPublishAt) * 1e6
}

/** Host ms of the last Trace snapshot publish — for tests / affine checks. */
export function lastTracePublishHostMs(): number {
  return lastPublishAt
}

/** Test helper: push synthetic CTF bytes as if the guest wrote them. */
export function debugFeed(bytes: Uint8Array) {
  if (!reader) reader = new TraceReader(defs)
  path = path ?? './tracing.bin'
  // Keep the test/demo hook synchronous; only the real filesystem follower
  // needs UI coalescing.
  if (reader.feed(bytes) > 0) {
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
