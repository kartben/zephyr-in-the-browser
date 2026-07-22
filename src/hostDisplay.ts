/** Browser end of the qemu,ramfb bridge exported by our qemu-wasm patch. */

// DRM_FORMAT_ARGB8888 ('A', 'R', '2', '4'), as configured by Zephyr's driver.
export const FOURCC_AR24 = 0x34325241

interface DisplayExports {
  _qemu_browser_ramfb_get_width?: () => number
  _qemu_browser_ramfb_get_height?: () => number
  _qemu_browser_ramfb_get_stride?: () => number
  _qemu_browser_ramfb_get_data?: () => number
  _qemu_browser_ramfb_get_fourcc?: () => number
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
}

const EMPTY: DisplaySnapshot = {
  available: false,
  width: 0,
  height: 0,
  stride: 0,
  fourcc: 0,
  pointer: 0,
}

let exports: DisplayExports | null = null
let snapshot = EMPTY
let poll: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

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
  const byteLength = stride * height
  const available =
    width > 0 &&
    height > 0 &&
    stride >= width * 4 &&
    pointer > 0 &&
    fourcc === FOURCC_AR24 &&
    pointer + byteLength <= exports.HEAPU8.byteLength

  return { available, width, height, stride, fourcc, pointer }
}

function refresh() {
  const next = inspect()
  if (
    next.available === snapshot.available &&
    next.width === snapshot.width &&
    next.height === snapshot.height &&
    next.stride === snapshot.stride &&
    next.fourcc === snapshot.fourcc &&
    next.pointer === snapshot.pointer
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
