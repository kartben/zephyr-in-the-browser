/**
 * Browser end of the pointer bridge added by
 * tools/qemu-jit-patches/0009-hw-misc-add-browser-input-bridge.patch.
 *
 * This is the first bridge with **no QEMU device of its own**: the guest talks
 * to a stock `virtio-tablet-device` on virtio-mmio, driven by Zephyr's upstream
 * `virtio,input` driver. All the patch adds is a frontend for QEMU's input core,
 * which qemu-wasm otherwise leaves unfed because it is built without SDL, GTK or
 * VNC. So the JS here does not model a device — it just replays pointer events
 * into an event ring that QEMU drains on its own thread.
 *
 * Records are four 32-bit words (`kind`, `code`, `value`, reserved) and the
 * write index is published **once per packet**, so QEMU never observes
 * coordinates without the SYNC that commits them.
 *
 * Motion is coalesced to at most one packet every `MOTION_INTERVAL_MS`, on a
 * timer of its own rather than on `requestAnimationFrame`: the guest's cost per
 * motion event has nothing to do with how often the *page* paints, and tying
 * the two made every drag a frame staler on a 60 Hz display than on a 120 Hz
 * one. Flooding the ring only costs latency and dropped packets anyway — the
 * newest position is the only one that matters.
 *
 * The primary button is reported as `BTN_TOUCH`, not `BTN_LEFT`: the panel is a
 * touch surface, the board's devicetree points `zephyr,touch` at this device,
 * and Zephyr's touch consumers (LVGL's pointer indev, the draw_touch_events
 * sample) all read `INPUT_BTN_TOUCH`. Secondary and middle buttons map straight
 * through for applications that want them.
 *
 * Being a touch surface also means there is no hover: motion is only sent while
 * something is held, so a mouse crossing the panel costs the guest nothing.
 */

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

/** Record kinds, mirroring hw/misc/qemu-browser-input.c. */
const KIND_SYNC = 0
const KIND_ABS = 1
const KIND_BTN = 2

/** QEMU's InputAxis enum. */
const AXIS_X = 0
const AXIS_Y = 1

/** QEMU's InputButton enum. */
const BTN_MIDDLE = 1
const BTN_RIGHT = 2
const BTN_WHEEL_UP = 3
const BTN_WHEEL_DOWN = 4
const BTN_TOUCH = 9

/** QEMU's absolute axis range (INPUT_EVENT_ABS_MIN..MAX). */
const ABS_MAX = 0x7fff

const WORDS_PER_EVENT = 4

/**
 * Minimum spacing between motion packets, in milliseconds. 125 Hz is finer than
 * a 600x400 panel can show and is a rate the guest keeps up with: driven at this
 * spacing for 1.5 s, draw_touch_events ends only ~16 ms behind the last point,
 * so no backlog accumulates. It is deliberately *not* the frame interval — the
 * limit is what the guest can redraw, not what the browser can paint.
 */
const MOTION_INTERVAL_MS = 8

/** DOM PointerEvent.buttons bits, in the order we diff them. */
const BUTTON_MAP: Array<{ mask: number; button: number }> = [
  { mask: 1, button: BTN_TOUCH },
  { mask: 2, button: BTN_RIGHT },
  { mask: 4, button: BTN_MIDDLE },
]

let exports: InputExports | null = null
let ringBase = 0
let ringEvents = 0
/** Int32 view over the ring, rebuilt whenever Emscripten grows the heap. */
let ringView: Int32Array | null = null
let ringBuffer: ArrayBufferLike | null = null

/** Last position pushed to the guest, in QEMU absolute units. */
let lastX = -1
let lastY = -1
/** Position waiting for the next flush, or null when nothing moved. */
let pendingX: number | null = null
let pendingY: number | null = null
/** Pending motion flush, and when the last one went out. */
let motionTimer: ReturnType<typeof setTimeout> | 0 = 0
let lastMotionAt = 0

/** DOM button bitmask currently held down. */
let heldButtons = 0

/**
 * Called by the qemu backend once its module is live. A build without the
 * input patch simply lacks the exports, which `available()` reports.
 *
 * Deliberately does not resolve the ring here: attach runs as soon as the
 * module exists, which can be before QEMU's machine init has armed the drain
 * timer. Geometry is read on first use instead, so an early attach does not
 * latch the bridge off.
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

/** Whether the running emulator carries the input bridge. */
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

/** Records that bring the guest's pointer to (x, y), or none if it is there. */
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
 * Absolute pointer position over the guest display, as fractions of its width
 * and height. The first move of a gesture goes out at once; the rest are
 * coalesced to one packet per `MOTION_INTERVAL_MS`, since a 1 kHz mouse would
 * otherwise interrupt the guest far more often than it can redraw.
 *
 * Motion with nothing held is dropped: this is a touch surface, and a finger
 * that is not touching has no position to report. Forwarding it anyway was
 * worse than merely redundant — a packet ends in SYNC, which is a *complete*
 * input report, so every hover step reached the guest as a touch event with
 * BTN_TOUCH clear. draw_touch_events logged one `TOUCH RELEASE` per mouse
 * move and redrew for each. Presses are unaffected: `setButtons` puts the
 * position in the same packet as the button, so a press never lands stale.
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

/**
 * Press/release state from a DOM `PointerEvent.buttons` bitmask, delivered in
 * the same packet as the position so the guest never presses at a stale point.
 */
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

/** Release everything still held — the pointer left the surface mid-drag. */
export function releaseButtons() {
  if (!available() || !heldButtons) return
  const records: Array<[number, number, number]> = []
  for (const { mask, button } of BUTTON_MAP) {
    if (heldButtons & mask) records.push([KIND_BTN, button, 0])
  }
  records.push([KIND_SYNC, 0, 0])
  if (writePacket(records)) heldButtons = 0
}

/**
 * Wheel notches, as QEMU's wheel "buttons": one press/release per notch, which
 * is how every other QEMU frontend reports scrolling.
 */
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
