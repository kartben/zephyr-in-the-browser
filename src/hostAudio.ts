/**
 * Browser end of the `qemu,host-audio` bridge.
 *
 * The QEMU device owns a ring of 16-bit mono PCM samples the guest fills over
 * MMIO. Its exports hand us the ring's location and geometry plus two
 * free-running frame counters: `get_write_index()` advances as the guest
 * produces, and `set_read_index()` reports what we consumed, which is how the
 * guest sees free space. Every access is a plain shared-memory operation — no
 * call ever enters the guest.
 *
 * Consumption runs on a 100 ms poll whether or not sound is enabled: a muted
 * page still drains (and drops) samples so the guest's flow control behaves
 * identically either way. Playback goes through the Web Audio API, which the
 * browser's autoplay policy gates behind a user gesture — hence enable() being
 * called from a click in AudioPanel rather than from attach().
 *
 * Like hostGpio, deliberately not part of the PtyBackend seam: the bridge is
 * optional, and a backend with no audio device need not know it exists.
 */

interface AudioExports {
  _qemu_host_audio_get_rate?: () => number
  _qemu_host_audio_get_buffer_frames?: () => number
  _qemu_host_audio_get_data?: () => number
  _qemu_host_audio_get_write_index?: () => number
  _qemu_host_audio_set_read_index?: (index: number) => void
  /** Shared-memory view emitted by Emscripten's pthread runtime. */
  HEAPU8?: Uint8Array
}

export interface AudioSnapshot {
  available: boolean
  /** Sound reaches the speakers; false while draining silently. */
  enabled: boolean
  /** Device sample rate in Hz, 0 until attached. */
  rate: number
  /** Peak of the most recent chunk, 0..1, for a level meter. */
  level: number
}

const EMPTY: AudioSnapshot = { available: false, enabled: false, rate: 0, level: 0 }

/** Keep scheduled audio this far ahead of the clock to ride out poll jitter. */
const LEAD_SECONDS = 0.06

let exports: AudioExports | null = null
let poller: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

let snapshot = EMPTY
let ctx: AudioContext | null = null
let enabled = false
/** Next free slot on the AudioContext timeline. */
let playhead = 0
/** Frames consumed so far, mirroring the device's free-running counter. */
let readIndex = 0

export function attach(mod: unknown) {
  detach()
  exports = mod as AudioExports
  if (available()) {
    readIndex = exports?._qemu_host_audio_get_write_index?.() ?? 0
    poller = setInterval(poll, 100)
  }
  update()
}

export function detach() {
  if (poller !== undefined) clearInterval(poller)
  poller = undefined
  exports = null
  enabled = false
  readIndex = 0
  playhead = 0
  void ctx?.close()
  ctx = null
  update()
}

export function available(): boolean {
  return (
    typeof exports?._qemu_host_audio_get_rate === 'function' &&
    typeof exports?._qemu_host_audio_get_buffer_frames === 'function' &&
    typeof exports?._qemu_host_audio_get_data === 'function' &&
    typeof exports?._qemu_host_audio_get_write_index === 'function' &&
    typeof exports?._qemu_host_audio_set_read_index === 'function' &&
    exports?.HEAPU8 !== undefined
  )
}

/** Must be called from a user gesture, per the browser autoplay policy. */
export function enable() {
  if (!available() || enabled) return
  ctx ??= new AudioContext()
  void ctx.resume()
  enabled = true
  playhead = 0
  update()
}

export function disable() {
  if (!enabled) return
  enabled = false
  void ctx?.suspend()
  update()
}

export function toggle() {
  if (enabled) disable()
  else enable()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): AudioSnapshot {
  return snapshot
}

function poll() {
  if (!available() || !exports) return
  const heap = exports.HEAPU8!
  const rate = exports._qemu_host_audio_get_rate!()
  const capacity = exports._qemu_host_audio_get_buffer_frames!()
  const data = exports._qemu_host_audio_get_data!()
  const writeIndex = exports._qemu_host_audio_get_write_index!() >>> 0

  let pending = (writeIndex - readIndex) >>> 0
  if (pending === 0) {
    update(0)
    return
  }
  // More than a full ring behind means the guest lapped us (should not happen
  // with the guest's own flow control, but a reset can skew the counters);
  // resync to the freshest window.
  if (pending > capacity) {
    readIndex = (writeIndex - capacity) >>> 0
    pending = capacity
  }

  // Copy out of the shared heap before touching the read index; int16 little-
  // endian, ring position is the counter modulo the power-of-two capacity.
  const samples = new Float32Array(pending)
  let peak = 0
  for (let i = 0; i < pending; i++) {
    const pos = ((readIndex + i) & (capacity - 1)) * 2
    const lo = heap[data + pos]!
    const hi = heap[data + pos + 1]!
    const raw = (hi << 8) | lo
    const value = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768
    samples[i] = value
    const mag = Math.abs(value)
    if (mag > peak) peak = mag
  }
  readIndex = writeIndex
  exports._qemu_host_audio_set_read_index!(readIndex)

  if (!enabled || !ctx || rate <= 0) {
    // Drained and dropped; the guest sees the same free space as when audible.
    update(0)
    return
  }

  const buffer = ctx.createBuffer(1, pending, rate)
  buffer.copyToChannel(samples, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  playhead = Math.max(playhead, ctx.currentTime + LEAD_SECONDS)
  source.start(playhead)
  playhead += pending / rate

  update(peak)
}

function update(level?: number) {
  const next: AudioSnapshot = {
    available: available(),
    enabled,
    rate: available() ? exports!._qemu_host_audio_get_rate!() : 0,
    // Quantised so a sustained tone does not re-render the panel every poll.
    level: Math.round((level ?? snapshot.level) * 20) / 20,
  }
  if (
    next.available === snapshot.available &&
    next.enabled === snapshot.enabled &&
    next.rate === snapshot.rate &&
    next.level === snapshot.level
  ) {
    return
  }
  snapshot = next
  for (const fn of listeners) fn()
}
