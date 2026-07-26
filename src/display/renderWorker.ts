/**
 * Dedicated render worker for the qemu,ramfb display.
 *
 * The framebuffer lives in QEMU's Emscripten heap, which is a SharedArrayBuffer
 * (a pthread build). That buffer is visible from any worker, so this one reads
 * it directly and paints an OffscreenCanvas transferred from the main thread —
 * moving the per-frame texture upload off the UI/terminal thread entirely.
 *
 * The main thread stays the source of truth for *metadata*: the guest only
 * (re)configures ramfb rarely, and each such change arrives as an `update`
 * message. Pixels are never posted; only the shared buffer and where to read.
 *
 * A changing frame follows presentation callbacks so it cannot miss guest
 * updates. The worker samples those callbacks at a controlled rate rather
 * than re-reading shared memory on every high-refresh tick. Once a panel stays
 * unchanged for a short grace period, its sequence is checked at 30 Hz instead.
 * A pointer event wakes the hot path immediately. New emulator artifacts expose
 * an atomic dirty sequence; older artifacts retain a checksum fallback.
 */
import { createWebGLRenderer, type FrameRenderer, type UploadMode } from './renderers'

/** The subset of hostDisplay's snapshot the worker needs to locate a frame. */
export interface WorkerSnapshot {
  available: boolean
  width: number
  height: number
  stride: number
  fourcc: number
  pointer: number
  frameSeqPointer: number
  frameWaitSupported: boolean
}

export type MainToWorker =
  | {
      type: 'init'
      canvas: OffscreenCanvas
      buffer: ArrayBufferLike
      snapshot: WorkerSnapshot
    }
  | { type: 'update'; buffer: ArrayBufferLike; snapshot: WorkerSnapshot }
  /** A user interaction is likely to make the guest paint; leave idle early. */
  | { type: 'wake' }
  | { type: 'profile'; enabled: boolean }
  | { type: 'stop' }

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'uploadMode'; mode: UploadMode }
  | { type: 'fatal'; message: string }
  | {
      type: 'frameStats'
      uploaded: boolean
      digestMs: number
      drawMs: number
      /** Total synchronous work in this worker tick, including the idle check. */
      checkMs: number
    }

// DOM lib types `self` as a Window; the runtime is a DedicatedWorkerGlobalScope
// whose postMessage takes no targetOrigin. Post through a narrow local view.
const post = (message: WorkerToMain) => {
  ;(self as unknown as { postMessage(message: WorkerToMain): void }).postMessage(message)
}

let canvas: OffscreenCanvas | null = null
let buffer: ArrayBufferLike | null = null
let snapshot: WorkerSnapshot | null = null
let renderer: FrameRenderer | null = null
let rendererKey = ''
let running = false
let frameHandle = 0
let frameScheduled = false
let scheduledWithRaf = false
/** Checksum of the last uploaded frame, and whether one has been uploaded. */
let lastDigest = 0
let hasDrawn = false
let frameSeqView: Int32Array | null = null
let frameSeqBuffer: SharedArrayBuffer | null = null
let frameSeqPointer = 0
let lastFrameSequence = 0
let hasFrameSequence = false
let frameWaitPending = false
let frameWaitGeneration = 0
/**
 * Consecutive frames that differed from their predecessor. Once the guest is
 * clearly animating, hashing every pixel before each upload is pure overhead —
 * chart samples change every frame. Stay on a hot path that always uploads,
 * and only re-arm the checksum after a quiet stretch so an idle panel still
 * costs nothing.
 */
let dirtyStreak = 0
const HOT_AFTER = 3
/** Re-check for a still frame about once a second while hot (~60 Hz present). */
const HOT_RECHECK_EVERY = 60
/** When true, time digest/draw and post frameStats to the main thread. */
let profiling = false

/** Limit active shared-memory reads to 72 Hz while retaining presentation pacing. */
const ACTIVE_INTERVAL_MS = 1000 / 72
/** 30 Hz keeps wake latency below a perceptible frame while idle. */
const IDLE_INTERVAL_MS = 1000 / 30
/** Covers a 25 Hz chart's quiet gap after a new frame, plus input wake latency. */
const HOT_GRACE_FRAMES = 9
let hotFramesRemaining = HOT_GRACE_FRAMES
let lastActiveCheckAt = 0
const hasRaf = typeof self.requestAnimationFrame === 'function'

type AtomicsWaitResult =
  | { async: true; value: Promise<'ok' | 'timed-out'> }
  | { async: false; value: 'not-equal' | 'timed-out' }
type AtomicsWithWaitAsync = typeof Atomics & {
  waitAsync?: (array: Int32Array, index: number, value: number) => AtomicsWaitResult
}

function scheduleNext(delay: number) {
  if (!running || frameScheduled) return
  frameScheduled = true
  scheduledWithRaf = delay === ACTIVE_INTERVAL_MS && hasRaf
  frameHandle = scheduledWithRaf
    ? self.requestAnimationFrame(frame)
    : self.setTimeout(frame, delay)
}

function cancelScheduledFrame() {
  if (!frameScheduled) return
  if (scheduledWithRaf) self.cancelAnimationFrame(frameHandle)
  else self.clearTimeout(frameHandle)
  frameScheduled = false
}

function scheduleAfterCheck(changed: boolean) {
  hotFramesRemaining = changed
    ? HOT_GRACE_FRAMES
    : Math.max(0, hotFramesRemaining - 1)
  scheduleNext(hotFramesRemaining ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS)
}

/**
 * Sleep without polling until QEMU publishes another dirty sequence. This is
 * deliberately opt-in: older artifacts increment the sequence but do not wake
 * JS waiters, so they retain the timed polling path above.
 */
function waitForFrameSequence(sequence: number): boolean {
  if (!snapshot?.frameWaitSupported || !frameSeqView) return false
  if (frameWaitPending) return true
  const waitAsync = (Atomics as AtomicsWithWaitAsync).waitAsync
  if (!waitAsync) return false

  const result = waitAsync.call(Atomics, frameSeqView, 0, sequence | 0)
  if (!result.async) return false

  const generation = frameWaitGeneration
  frameWaitPending = true
  void result.value.then(
    () => {
      if (generation !== frameWaitGeneration) return
      frameWaitPending = false
      if (running) scheduleNext(0)
    },
    () => {
      if (generation !== frameWaitGeneration) return
      frameWaitPending = false
      if (running) scheduleNext(IDLE_INTERVAL_MS)
    },
  )
  return true
}

function wake() {
  hotFramesRemaining = HOT_GRACE_FRAMES
  lastActiveCheckAt = 0
  if (!running) return
  cancelScheduledFrame()
  scheduleNext(0)
}

/**
 * Checksum of a frame, over every 32-bit pixel — a subsample would miss exactly
 * what matters here, a one-pixel-wide cursor or cross. Position-sensitive, so
 * a mark that moves without changing colour still registers. Returns null when
 * the frame cannot be viewed as 32-bit words, which forces an upload.
 */
function digest(buffer: ArrayBufferLike, pointer: number, length: number): number | null {
  if (pointer % 4 !== 0 || length % 4 !== 0) return null
  const words = new Uint32Array(buffer, pointer, length / 4)
  let hash = 0x811c9dc5
  for (let i = 0; i < words.length; i += 1) hash = Math.imul(hash ^ words[i], 0x01000193)
  return hash
}

function resetFrameTracking() {
  lastDigest = 0
  hasDrawn = false
  dirtyStreak = 0
  frameSeqView = null
  frameSeqBuffer = null
  frameSeqPointer = 0
  lastFrameSequence = 0
  hasFrameSequence = false
  frameWaitPending = false
  frameWaitGeneration += 1
  hotFramesRemaining = HOT_GRACE_FRAMES
  lastActiveCheckAt = 0
}

/** Read QEMU's atomic dirty sequence, or null when the artifact predates it. */
function getFrameSequence(source: ArrayBufferLike, pointer: number): number | null {
  if (
    typeof SharedArrayBuffer === 'undefined' ||
    !(source instanceof SharedArrayBuffer) ||
    pointer <= 0 ||
    pointer % Int32Array.BYTES_PER_ELEMENT !== 0 ||
    pointer + Int32Array.BYTES_PER_ELEMENT > source.byteLength
  ) {
    return null
  }
  if (frameSeqBuffer !== source || frameSeqPointer !== pointer) {
    frameSeqView = new Int32Array(source, pointer, 1)
    frameSeqBuffer = source
    frameSeqPointer = pointer
  }
  return frameSeqView ? Atomics.load(frameSeqView, 0) >>> 0 : null
}

function buildRenderer(view: OffscreenCanvas, snap: WorkerSnapshot): boolean {
  renderer?.dispose()
  renderer = null
  resetFrameTracking()
  try {
    view.width = snap.width
    view.height = snap.height
    renderer = createWebGLRenderer(view, snap.width, snap.height, snap.stride, {
      onUploadMode: (mode) => post({ type: 'uploadMode', mode }),
    })
    rendererKey = `${snap.width}x${snap.height}:${snap.stride}`
    post({ type: 'ready' })
    return true
  } catch (error) {
    post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    return false
  }
}

function frame(timestamp?: number) {
  if (!running) return
  frameScheduled = false
  scheduledWithRaf = false
  const now = timestamp ?? performance.now()
  if (
    hotFramesRemaining > 0 &&
    lastActiveCheckAt > 0 &&
    now - lastActiveCheckAt < ACTIVE_INTERVAL_MS
  ) {
    scheduleNext(ACTIVE_INTERVAL_MS)
    return
  }
  lastActiveCheckAt = now
  if (!snapshot || !snapshot.available || !buffer || !canvas) {
    scheduleNext(IDLE_INTERVAL_MS)
    return
  }

  const key = `${snapshot.width}x${snapshot.height}:${snapshot.stride}`
  if (!renderer || key !== rendererKey) {
    // A resolution change (or the first frame) needs a fresh texture. Give up
    // the worker path on failure so the main thread can fall back.
    if (!buildRenderer(canvas, snapshot)) {
      running = false
      return
    }
  }

  const length = snapshot.stride * snapshot.height
  if (snapshot.pointer <= 0 || snapshot.pointer + length > buffer.byteLength) {
    scheduleNext(IDLE_INTERVAL_MS)
    return
  }

  const checkStart = profiling ? performance.now() : 0
  let digestMs = 0
  let uploaded = true
  const sequence = getFrameSequence(buffer, snapshot.frameSeqPointer)
  if (sequence !== null) {
    if (hasFrameSequence && sequence === lastFrameSequence) {
      uploaded = false
      if (profiling) {
        post({
          type: 'frameStats',
          uploaded,
          digestMs,
          drawMs: 0,
          checkMs: performance.now() - checkStart,
        })
      }
      if (!waitForFrameSequence(sequence)) scheduleAfterCheck(false)
      return
    }
    hasFrameSequence = true
    lastFrameSequence = sequence
  } else {
    // Old QEMU artifacts do not publish a dirty bit, so content is the signal.
    const hot = dirtyStreak >= HOT_AFTER
    const recheck = hot && dirtyStreak % HOT_RECHECK_EVERY === 0
    if (!hot || recheck) {
      const t0 = profiling ? performance.now() : 0
      const hash = digest(buffer, snapshot.pointer, length)
      if (profiling) digestMs = performance.now() - t0
      if (hasDrawn && hash !== null && hash === lastDigest) {
        dirtyStreak = 0
        uploaded = false
        if (profiling) {
          post({
            type: 'frameStats',
            uploaded,
            digestMs,
            drawMs: 0,
            checkMs: performance.now() - checkStart,
          })
        }
        scheduleAfterCheck(false)
        return
      }
      lastDigest = hash ?? 0
    }
    dirtyStreak += 1
  }
  hasDrawn = true

  // Re-view every frame: an in-place heap growth keeps the SharedArrayBuffer's
  // identity but enlarges it, and a stale view would clamp to the old length.
  const t1 = profiling ? performance.now() : 0
  renderer!.draw(new Uint8Array(buffer, snapshot.pointer, length))
  if (profiling) {
    post({
      type: 'frameStats',
      uploaded,
      digestMs,
      drawMs: performance.now() - t1,
      checkMs: performance.now() - checkStart,
    })
  }
  if (sequence === null || !waitForFrameSequence(sequence)) scheduleAfterCheck(true)
}

self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as MainToWorker
  if (message.type === 'init') {
    canvas = message.canvas
    buffer = message.buffer
    snapshot = message.snapshot
    resetFrameTracking()
    if (!running) {
      running = true
      scheduleNext(0)
    }
  } else if (message.type === 'update') {
    // A new buffer or pixel address invalidates the checksum: the same content
    // at a new address must still reach the canvas.
    buffer = message.buffer
    snapshot = message.snapshot
    resetFrameTracking()
    wake()
  } else if (message.type === 'wake') {
    wake()
  } else if (message.type === 'profile') {
    profiling = message.enabled
  } else if (message.type === 'stop') {
    running = false
    cancelScheduledFrame()
    renderer?.dispose()
    renderer = null
    canvas = null
    buffer = null
    snapshot = null
    resetFrameTracking()
  }
})
