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
 * Motion is coalesced to one packet per animation frame. The drain timer runs
 * on QEMU's *virtual* clock, which under `-icount shift=4` can lag wall time
 * badly while the guest is busy, so flooding the ring only costs latency and
 * dropped packets — the newest position is the only one that matters anyway.
 *
 * The primary button is reported as `BTN_TOUCH`, not `BTN_LEFT`: the panel is a
 * touch surface, the board's devicetree points `zephyr,touch` at this device,
 * and Zephyr's touch consumers (LVGL's pointer indev, the draw_touch_events
 * sample) all read `INPUT_BTN_TOUCH`. Secondary and middle buttons map straight
 * through for applications that want them.
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
/** Position waiting for the next frame, or null when nothing moved. */
let pendingX: number | null = null
let pendingY: number | null = null
let frame = 0

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
  if (frame) cancelAnimationFrame(frame)
  frame = 0
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
  frame = 0
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
 * and height. Coalesced to one packet per frame — a pointermove burst at
 * 120 Hz would otherwise outrun the guest's drain.
 */
export function movePointer(nx: number, ny: number) {
  if (!available()) return
  pendingX = clampAbs(nx)
  pendingY = clampAbs(ny)
  if (!frame) frame = requestAnimationFrame(flushMotion)
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
    pendingX = null
    pendingY = null
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
