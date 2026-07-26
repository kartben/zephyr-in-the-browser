/** Browser end of QEMU's pointer bridge. */

interface InputExports {
  _qemu_browser_input_ready?: () => number
  _qemu_browser_input_ring_events?: () => number
  _qemu_browser_input_ring?: () => number
  _qemu_browser_input_write_index?: () => number
  _qemu_browser_input_read_index?: () => number
  _qemu_browser_input_set_write_index?: (value: number) => void
  /** Refreshed by Emscripten on memory growth — always read via the module. */
  HEAPU8?: Uint8Array
}

const KIND_SYNC = 0
const KIND_ABS = 1
const KIND_BTN = 2

const AXIS_X = 0
const AXIS_Y = 1

const BTN_MIDDLE = 1
const BTN_RIGHT = 2
const BTN_WHEEL_UP = 3
const BTN_WHEEL_DOWN = 4
const BTN_TOUCH = 9

const ABS_MAX = 0x7fff

const WORDS_PER_EVENT = 4

/** Coalesce motion to what the guest can redraw; newest position wins. */
const MOTION_INTERVAL_MS = 8

const BUTTON_MAP: Array<{ mask: number; button: number }> = [
  { mask: 1, button: BTN_TOUCH },
  { mask: 2, button: BTN_RIGHT },
  { mask: 4, button: BTN_MIDDLE },
]

let exports: InputExports | null = null
let ringBase = 0
let ringEvents = 0
let ringView: Int32Array | null = null
let ringBuffer: ArrayBufferLike | null = null

let lastX = -1
let lastY = -1
let pendingX: number | null = null
let pendingY: number | null = null
let motionTimer: ReturnType<typeof setTimeout> | 0 = 0
let lastMotionAt = 0

let heldButtons = 0

/**
 * Geometry is read on first use because attach can run before QEMU arms the
 * drain timer.
 */
export function attach(mod: unknown) {
  detach()
  exports = mod as InputExports
}

export function detach() {
  if (motionTimer) clearTimeout(motionTimer)
  motionTimer = 0
  lastMotionAt = 0
  exports = null
  ringView = null
  ringBuffer = null
  ringBase = 0
  ringEvents = 0
  lastX = -1
  lastY = -1
  pendingX = null
  pendingY = null
  heldButtons = 0
}

export function available(): boolean {
  return Boolean(
    exports?.HEAPU8 &&
      exports._qemu_browser_input_ready?.() &&
      exports._qemu_browser_input_ring &&
      exports._qemu_browser_input_ring_events &&
      exports._qemu_browser_input_write_index &&
      exports._qemu_browser_input_read_index &&
      exports._qemu_browser_input_set_write_index,
  )
}

function view(): Int32Array | null {
  const heap = exports?.HEAPU8
  if (!heap) return null
  if (!ringEvents) {
    ringBase = exports!._qemu_browser_input_ring!()
    ringEvents = exports!._qemu_browser_input_ring_events!()
    if (!ringBase || !ringEvents) return null
  }
  if (!ringView || ringBuffer !== heap.buffer) {
    ringBuffer = heap.buffer
    ringView = new Int32Array(heap.buffer, ringBase, ringEvents * WORDS_PER_EVENT)
  }
  return ringView
}

/**
 * Append one packet — a group of records the guest must see atomically —
 * and publish it. Returns false when the ring is too full to take it, in
 * which case the packet is dropped whole rather than half-written.
 */
function writePacket(records: Array<[number, number, number]>): boolean {
  const ring = view()
  if (!ring || !exports) return false

  // wasm i32 returns arrive signed; the indices are free-running u32s.
  const rd = exports._qemu_browser_input_read_index!() >>> 0
  let wr = exports._qemu_browser_input_write_index!() >>> 0
  if (((wr - rd) >>> 0) + records.length > ringEvents) return false

  for (const [kind, code, value] of records) {
    const base = (wr % ringEvents) * WORDS_PER_EVENT
    ring[base] = kind
    ring[base + 1] = code
    ring[base + 2] = value
    ring[base + 3] = 0
    wr = (wr + 1) >>> 0
  }
  exports._qemu_browser_input_set_write_index!(wr)
  return true
}

function moveRecords(x: number, y: number): Array<[number, number, number]> {
  const records: Array<[number, number, number]> = []
  if (x !== lastX) records.push([KIND_ABS, AXIS_X, x])
  if (y !== lastY) records.push([KIND_ABS, AXIS_Y, y])
  return records
}

function clampAbs(normalized: number): number {
  return Math.max(0, Math.min(ABS_MAX, Math.round(normalized * ABS_MAX)))
}

function flushMotion() {
  motionTimer = 0
  lastMotionAt = performance.now()
  if (pendingX === null || pendingY === null) return
  const x = pendingX
  const y = pendingY
  pendingX = null
  pendingY = null

  const records = moveRecords(x, y)
  if (!records.length) return
  records.push([KIND_SYNC, 0, 0])
  if (writePacket(records)) {
    lastX = x
    lastY = y
  }
}

/**
 * Motion is only sent while touching; hover would be a complete SYNC report
 * with BTN_TOUCH clear and makes touch consumers redraw releases.
 */
export function movePointer(nx: number, ny: number) {
  if (!heldButtons || !available()) return
  pendingX = clampAbs(nx)
  pendingY = clampAbs(ny)
  if (motionTimer) return

  const wait = lastMotionAt + MOTION_INTERVAL_MS - performance.now()
  if (wait <= 0) flushMotion()
  else motionTimer = setTimeout(flushMotion, wait)
}

/** Button changes share a packet with position so presses never land stale. */
export function setButtons(nx: number, ny: number, buttons: number) {
  if (!available()) return
  const x = clampAbs(nx)
  const y = clampAbs(ny)

  const records = moveRecords(x, y)
  for (const { mask, button } of BUTTON_MAP) {
    const was = (heldButtons & mask) !== 0
    const now = (buttons & mask) !== 0
    if (was !== now) records.push([KIND_BTN, button, now ? 1 : 0])
  }
  if (!records.length) return

  records.push([KIND_SYNC, 0, 0])
  if (writePacket(records)) {
    lastX = x
    lastY = y
    heldButtons = buttons
    // A queued move would now be stale, and re-sending this point is a no-op.
    // The press carried a position, so it also starts the motion interval.
    pendingX = null
    pendingY = null
    if (motionTimer) clearTimeout(motionTimer)
    motionTimer = 0
    lastMotionAt = performance.now()
  }
}

export function releaseButtons() {
  if (!available() || !heldButtons) return
  const records: Array<[number, number, number]> = []
  for (const { mask, button } of BUTTON_MAP) {
    if (heldButtons & mask) records.push([KIND_BTN, button, 0])
  }
  records.push([KIND_SYNC, 0, 0])
  if (writePacket(records)) heldButtons = 0
}

export function scroll(deltaY: number) {
  if (!available() || !deltaY) return
  const button = deltaY < 0 ? BTN_WHEEL_UP : BTN_WHEEL_DOWN
  writePacket([
    [KIND_BTN, button, 1],
    [KIND_SYNC, 0, 0],
    [KIND_BTN, button, 0],
    [KIND_SYNC, 0, 0],
  ])
}
