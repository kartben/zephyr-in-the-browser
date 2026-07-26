/**
 * Render qemu,ramfb from QEMU's SharedArrayBuffer into a transferred
 * OffscreenCanvas. Pixels are never posted; metadata arrives via update.
 */
import { createWebGLRenderer, type FrameRenderer, type UploadMode } from './renderers'

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
      checkMs: number
    }

// DOM lib types `self` as Window; the runtime is a DedicatedWorkerGlobalScope.
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
let lastDigest = 0
let hasDrawn = false
let frameSeqView: Int32Array | null = null
let frameSeqBuffer: SharedArrayBuffer | null = null
let frameSeqPointer = 0
let lastFrameSequence = 0
let hasFrameSequence = false
let frameWaitPending = false
let frameWaitGeneration = 0
// Once frames are clearly changing, skip per-frame hashing until a quiet stretch.
let dirtyStreak = 0
const HOT_AFTER = 3
const HOT_RECHECK_EVERY = 60
let profiling = false

const ACTIVE_INTERVAL_MS = 1000 / 72
const IDLE_INTERVAL_MS = 1000 / 30
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
 * Sleep until QEMU publishes another dirty sequence; older artifacts increment
 * the sequence but do not wake JS waiters, so they keep timed polling.
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
 * Full-frame checksum; subsampling can miss one-pixel cursors/crosses.
 * Returns null when the frame cannot be viewed as 32-bit words.
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

// Read QEMU's atomic dirty sequence, or null when the artifact predates it.
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
    // A resolution change needs a fresh texture; failure falls back to main.
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
    // Old QEMU artifacts do not publish a dirty sequence; content is the signal.
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

  // Re-view every frame: heap growth preserves buffer identity but changes length.
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
    // New buffer or pixel address invalidates the checksum.
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
