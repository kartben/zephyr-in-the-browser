/** Browser end of the qemu,ramfb bridge exported by our qemu-wasm patch. */

// DRM_FORMAT_ARGB8888 ('A', 'R', '2', '4'), as configured by Zephyr's driver.
export const FOURCC_AR24 = 0x34325241

interface DisplayExports {
  _qemu_browser_ramfb_get_width?: () => number
  _qemu_browser_ramfb_get_height?: () => number
  _qemu_browser_ramfb_get_stride?: () => number
  _qemu_browser_ramfb_get_data?: () => number
  _qemu_browser_ramfb_get_fourcc?: () => number
  _qemu_browser_ramfb_get_frame_seq_ptr?: () => number
  /** Newer artifacts wake Atomics.waitAsync readers after incrementing the sequence. */
  _qemu_browser_ramfb_frame_wait_supported?: () => number
  /** Shared-memory view emitted by Emscripten's pthread runtime. */
  HEAPU8?: Uint8Array
}

export interface DisplaySnapshot {
  available: boolean
  width: number
  height: number
  stride: number
  fourcc: number
  pointer: number
  /** Atomic uint32 updated by QEMU after a guest framebuffer write. */
  frameSeqPointer: number
  /** QEMU wakes waiters after incrementing frameSeqPointer. */
  frameWaitSupported: boolean
}

const EMPTY: DisplaySnapshot = {
  available: false,
  width: 0,
  height: 0,
  stride: 0,
  fourcc: 0,
  pointer: 0,
  frameSeqPointer: 0,
  frameWaitSupported: false,
}

let exports: DisplayExports | null = null
let snapshot = EMPTY
let poll: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()
let frameSeqView: Int32Array | null = null
let frameSeqBuffer: SharedArrayBuffer | null = null
let frameSeqPointer = 0

function inspect(): DisplaySnapshot {
  if (
    !exports?.HEAPU8 ||
    !exports._qemu_browser_ramfb_get_width ||
    !exports._qemu_browser_ramfb_get_height ||
    !exports._qemu_browser_ramfb_get_stride ||
    !exports._qemu_browser_ramfb_get_data ||
    !exports._qemu_browser_ramfb_get_fourcc
  ) {
    return EMPTY
  }

  const width = exports._qemu_browser_ramfb_get_width()
  const height = exports._qemu_browser_ramfb_get_height()
  const stride = exports._qemu_browser_ramfb_get_stride()
  const pointer = exports._qemu_browser_ramfb_get_data()
  const fourcc = exports._qemu_browser_ramfb_get_fourcc()
  // The counter was added after the original display bridge. Keep it optional
  // so an already-built emulator continues using the renderer's checksum path.
  const nextFrameSeqPointer = exports._qemu_browser_ramfb_get_frame_seq_ptr?.() ?? 0
  const frameWaitSupported =
    nextFrameSeqPointer > 0 && exports._qemu_browser_ramfb_frame_wait_supported?.() === 1
  const byteLength = stride * height
  const available =
    width > 0 &&
    height > 0 &&
    stride >= width * 4 &&
    pointer > 0 &&
    fourcc === FOURCC_AR24 &&
    pointer + byteLength <= exports.HEAPU8.byteLength

  return {
    available,
    width,
    height,
    stride,
    fourcc,
    pointer,
    frameSeqPointer: nextFrameSeqPointer,
    frameWaitSupported,
  }
}

function refresh() {
  const next = inspect()
  if (
    next.available === snapshot.available &&
    next.width === snapshot.width &&
    next.height === snapshot.height &&
    next.stride === snapshot.stride &&
    next.fourcc === snapshot.fourcc &&
    next.pointer === snapshot.pointer &&
    next.frameSeqPointer === snapshot.frameSeqPointer &&
    next.frameWaitSupported === snapshot.frameWaitSupported
  ) {
    return
  }
  snapshot = next
  for (const fn of listeners) fn()
}

/** The guest configures ramfb after boot, so poll until its fw_cfg write lands. */
export function attach(mod: unknown) {
  detach()
  exports = mod as DisplayExports
  refresh()
  poll = setInterval(refresh, 200)
}

export function detach() {
  if (poll !== undefined) clearInterval(poll)
  poll = undefined
  exports = null
  frameSeqView = null
  frameSeqBuffer = null
  frameSeqPointer = 0
  if (snapshot !== EMPTY) {
    snapshot = EMPTY
    for (const fn of listeners) fn()
  }
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): DisplaySnapshot {
  return snapshot
}

/** A zero-copy view of the current BGRA framebuffer, including row padding. */
export function getFrame(): Uint8Array | null {
  if (!snapshot.available || !exports?.HEAPU8) return null
  const end = snapshot.pointer + snapshot.stride * snapshot.height
  if (end > exports.HEAPU8.byteLength) return null
  return exports.HEAPU8.subarray(snapshot.pointer, end)
}

/**
 * The QEMU-side dirty tracker increments this shared uint32 after a guest
 * write. A null result means this is an older emulator, a non-pthread build,
 * or an invalid export; callers should retain their content-based fallback.
 */
export function getFrameSequence(): number | null {
  const heap = exports?.HEAPU8
  const pointer = snapshot.frameSeqPointer
  if (
    !snapshot.available ||
    !heap ||
    typeof SharedArrayBuffer === 'undefined' ||
    !(heap.buffer instanceof SharedArrayBuffer) ||
    pointer <= 0 ||
    pointer % Int32Array.BYTES_PER_ELEMENT !== 0 ||
    pointer + Int32Array.BYTES_PER_ELEMENT > heap.byteLength
  ) {
    return null
  }

  if (frameSeqBuffer !== heap.buffer || frameSeqPointer !== pointer) {
    frameSeqView = new Int32Array(heap.buffer, pointer, 1)
    frameSeqBuffer = heap.buffer
    frameSeqPointer = pointer
  }
  return frameSeqView ? Atomics.load(frameSeqView, 0) >>> 0 : null
}

/**
 * The Emscripten heap that backs getFrame(), for handing to a render worker.
 * On a pthread build this is a SharedArrayBuffer, so a worker can read the
 * framebuffer directly at `snapshot.pointer` without any pixels being posted.
 * Null until a module is attached.
 */
export function getSharedBuffer(): ArrayBufferLike | null {
  return exports?.HEAPU8?.buffer ?? null
}
