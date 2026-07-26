/**
 * Browser end of Zephyr's semihosting CTF backend. Polls MEMFS `tracing.bin`
 * into TraceReader and stays hidden until the file or events appear.
 */

import { fallbackDefs, loadEventDefs, TraceReader, type Trace } from '@/ctf'

const TRACE_PATHS = ['./tracing.bin', '/tracing.bin', 'tracing.bin']
const METADATA_URL = `${import.meta.env.BASE_URL}tracing/metadata`
const POLL_MS = 200
/** Cap retained events so a long-running sample cannot unbounded-grow the heap. */
const MAX_EVENTS = 50_000

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
let poll: ReturnType<typeof setInterval> | undefined
let snapshot: TraceSnapshot = EMPTY
let defsReady: Promise<void> | null = null
let defs = fallbackDefs()
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
  if (tr.events.length > MAX_EVENTS) {
    // Rebuilding the derived timelines from a truncated event list is more
    // honest than mutating segments in place; rare, so pay the cost then.
    const keep = tr.events.slice(-MAX_EVENTS)
    const next = new TraceReader(defs)
    // Re-feed is not possible from events alone without re-encoding; instead
    // just trim the events array for the log and leave segments as-is. The
    // Gantt still renders from states/segments which stay bounded by thread
    // count × state changes, not by event count.
    tr.events = keep
    void next
  }
  snapshot = {
    available: tr.events.length > 0 || path !== null,
    following: path !== null,
    eventCount: tr.events.length,
    threadCount: tr.threads.size,
    desync: reader.desync,
    spanNs: tr.events.length ? tr.t1 - tr.t0 : 0,
    trace: tr,
    path,
  }
  notify()
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
    reader.feed(chunk)
    publish()
  } else if (snapshot.path !== path) {
    publish()
  }
}

export function attach(instance: unknown) {
  detach()
  mod = instance as TraceModule
  void ensureDefs()
  sample()
  poll = setInterval(sample, POLL_MS)
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  mod = null
  reader = null
  offset = 0
  path = null
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

/** Test helper: push synthetic CTF bytes as if the guest wrote them. */
export function debugFeed(bytes: Uint8Array) {
  if (!reader) reader = new TraceReader(defs)
  path = path ?? './tracing.bin'
  reader.feed(bytes)
  publish()
}

// Dev-only hook so screenshot / manual demos can inject a synthetic CTF stream
// without a qemu-wasm build. Production builds tree-shake this away via DEV.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __zephyrTraceDebugFeed?: typeof debugFeed }).__zephyrTraceDebugFeed =
    debugFeed
}
