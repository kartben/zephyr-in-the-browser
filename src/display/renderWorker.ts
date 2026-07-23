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
      frameIntervalMs: number
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
let frameIntervalMs = 1000 / 30
let previous = 0
let running = false
let frameHandle = 0

// Worker requestAnimationFrame drives OffscreenCanvas presentation where it
// exists (all current WebGL2-capable browsers); fall back to a timer otherwise.
const hasRaf = typeof self.requestAnimationFrame === 'function'
const schedule = (callback: (now: number) => void): number =>
  hasRaf
    ? self.requestAnimationFrame(callback)
    : self.setTimeout(() => callback(self.performance.now()), 1000 / 60)
const unschedule = (handle: number) => {
  if (hasRaf) self.cancelAnimationFrame(handle)
  else self.clearTimeout(handle)
}

function buildRenderer(view: OffscreenCanvas, snap: WorkerSnapshot): boolean {
  renderer?.dispose()
  renderer = null
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

function frame(now: number) {
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

  if (now - previous < frameIntervalMs) return
  previous = now

  const length = snapshot.stride * snapshot.height
  if (snapshot.pointer <= 0 || snapshot.pointer + length > buffer.byteLength) return
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
    frameIntervalMs = message.frameIntervalMs
    previous = 0
    if (!running) {
      running = true
      frameHandle = schedule(frame)
    }
  } else if (message.type === 'update') {
    buffer = message.buffer
    snapshot = message.snapshot
  } else if (message.type === 'stop') {
    running = false
    unschedule(frameHandle)
    renderer?.dispose()
    renderer = null
    canvas = null
    buffer = null
    snapshot = null
  }
})
