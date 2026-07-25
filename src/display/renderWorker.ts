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
 * Frames go out at the display's own rate rather than a fixed 30 fps. The cap
 * was there because the upload used to compete with xterm and React on the main
 * thread — which is why the main-thread renderers still keep one — but this
 * thread has nothing to compete with. What replaces it is a checksum: a frame is
 * uploaded only when it differs from the last, so an idle panel costs one read
 * of the framebuffer and no upload at all. While the guest is animating (chart
 * samples, music demo), the checksum is skipped after a short dirty streak so
 * the hashing itself does not tax every present.
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
}

export type MainToWorker =
  | {
      type: 'init'
      canvas: OffscreenCanvas
      buffer: ArrayBufferLike
      snapshot: WorkerSnapshot
    }
  | { type: 'update'; buffer: ArrayBufferLike; snapshot: WorkerSnapshot }
  | { type: 'stop' }

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'uploadMode'; mode: UploadMode }
  | { type: 'fatal'; message: string }

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
/** Checksum of the last uploaded frame, and whether one has been uploaded. */
let lastDigest = 0
let hasDrawn = false
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

// Worker requestAnimationFrame drives OffscreenCanvas presentation where it
// exists (all current WebGL2-capable browsers); fall back to a timer otherwise.
const hasRaf = typeof self.requestAnimationFrame === 'function'
const schedule = (callback: () => void): number =>
  hasRaf ? self.requestAnimationFrame(callback) : self.setTimeout(callback, 1000 / 60)
const unschedule = (handle: number) => {
  if (hasRaf) self.cancelAnimationFrame(handle)
  else self.clearTimeout(handle)
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

function buildRenderer(view: OffscreenCanvas, snap: WorkerSnapshot): boolean {
  renderer?.dispose()
  renderer = null
  hasDrawn = false
  dirtyStreak = 0
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

function frame() {
  if (!running) return
  frameHandle = schedule(frame)
  if (!snapshot || !snapshot.available || !buffer || !canvas) return

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
  if (snapshot.pointer <= 0 || snapshot.pointer + length > buffer.byteLength) return

  // Skip frames the guest has not touched. The guest writes the framebuffer
  // directly and ramfb has no dirty bit to read, so the content is the signal.
  const hot = dirtyStreak >= HOT_AFTER
  const recheck = hot && dirtyStreak % HOT_RECHECK_EVERY === 0
  if (!hot || recheck) {
    const hash = digest(buffer, snapshot.pointer, length)
    if (hasDrawn && hash !== null && hash === lastDigest) {
      dirtyStreak = 0
      return
    }
    lastDigest = hash ?? 0
  }
  dirtyStreak += 1
  hasDrawn = true

  // Re-view every frame: an in-place heap growth keeps the SharedArrayBuffer's
  // identity but enlarges it, and a stale view would clamp to the old length.
  renderer!.draw(new Uint8Array(buffer, snapshot.pointer, length))
}

self.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as MainToWorker
  if (message.type === 'init') {
    canvas = message.canvas
    buffer = message.buffer
    snapshot = message.snapshot
    hasDrawn = false
    dirtyStreak = 0
    if (!running) {
      running = true
      frameHandle = schedule(frame)
    }
  } else if (message.type === 'update') {
    // A new buffer or pixel address invalidates the checksum: the same content
    // at a new address must still reach the canvas.
    buffer = message.buffer
    snapshot = message.snapshot
    hasDrawn = false
    dirtyStreak = 0
  } else if (message.type === 'stop') {
    running = false
    unschedule(frameHandle)
    renderer?.dispose()
    renderer = null
    canvas = null
    buffer = null
    snapshot = null
    hasDrawn = false
    dirtyStreak = 0
  }
})
