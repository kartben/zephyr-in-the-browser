/**
 * Browser end of the `qemu,host-audio` ring. Muted playback still drains and
 * drops samples so guest flow control is unchanged; audible playback must start
 * from a user gesture because of browser autoplay policy.
 */

interface AudioExports {
  _qemu_host_audio_get_rate?: () => number
  _qemu_host_audio_get_channels?: () => number
  _qemu_host_audio_get_buffer_samples?: () => number
  _qemu_host_audio_get_data?: () => number
  _qemu_host_audio_get_write_index?: () => number
  _qemu_host_audio_set_read_index?: (index: number) => void
  HEAPU8?: Uint8Array
}

export interface AudioSnapshot {
  available: boolean
  enabled: boolean
  rate: number
  channels: number
  level: number
}

const EMPTY: AudioSnapshot = { available: false, enabled: false, rate: 0, channels: 1, level: 0 }

/** Keep scheduled audio this far ahead of the clock to ride out poll jitter. */
const LEAD_SECONDS = 0.06

let exports: AudioExports | null = null
let poller: ReturnType<typeof setInterval> | undefined
const listeners = new Set<() => void>()

let snapshot = EMPTY
let ctx: AudioContext | null = null
let enabled = false
let playhead = 0
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
    typeof exports?._qemu_host_audio_get_channels === 'function' &&
    typeof exports?._qemu_host_audio_get_buffer_samples === 'function' &&
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
  const channels = exports._qemu_host_audio_get_channels!()
  const capacity = exports._qemu_host_audio_get_buffer_samples!()
  const data = exports._qemu_host_audio_get_data!()
  const writeIndex = exports._qemu_host_audio_get_write_index!() >>> 0

  let pending = (writeIndex - readIndex) >>> 0
  if (pending > capacity) {
    // More than a full ring behind means the guest lapped us (should not
    // happen with the guest's own flow control, but a reset can skew the
    // counters); resync to the freshest window, on a frame boundary.
    readIndex = (writeIndex - capacity + (capacity % channels)) >>> 0
    pending = (writeIndex - readIndex) >>> 0
  }
  // Only whole interleaved frames; a torn frame stays for the next poll.
  const frames = Math.floor(pending / channels)
  if (frames === 0) {
    update(0)
    return
  }
  const count = frames * channels

  // Copy out of the shared heap before touching the read index; int16 little-
  // endian, ring position is the counter modulo the power-of-two capacity.
  const samples = new Float32Array(count)
  let peak = 0
  for (let i = 0; i < count; i++) {
    const pos = ((readIndex + i) & (capacity - 1)) * 2
    const lo = heap[data + pos]!
    const hi = heap[data + pos + 1]!
    const raw = (hi << 8) | lo
    const value = (raw >= 0x8000 ? raw - 0x10000 : raw) / 32768
    samples[i] = value
    const mag = Math.abs(value)
    if (mag > peak) peak = mag
  }
  readIndex = (readIndex + count) >>> 0
  exports._qemu_host_audio_set_read_index!(readIndex)

  if (!enabled || !ctx || rate <= 0) {
    // Drained and dropped; the guest sees the same free space as when audible.
    update(0)
    return
  }

  const buffer = ctx.createBuffer(channels, frames, rate)
  for (let ch = 0; ch < channels; ch++) {
    const plane = new Float32Array(frames)
    for (let i = 0; i < frames; i++) plane[i] = samples[i * channels + ch]!
    buffer.copyToChannel(plane, ch)
  }
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  playhead = Math.max(playhead, ctx.currentTime + LEAD_SECONDS)
  source.start(playhead)
  playhead += frames / rate

  update(peak)
}

function update(level?: number) {
  const next: AudioSnapshot = {
    available: available(),
    enabled,
    rate: available() ? exports!._qemu_host_audio_get_rate!() : 0,
    channels: available() ? exports!._qemu_host_audio_get_channels!() : 1,
    // Quantised so a sustained tone does not re-render the panel every poll.
    level: Math.round((level ?? snapshot.level) * 20) / 20,
  }
  if (
    next.available === snapshot.available &&
    next.enabled === snapshot.enabled &&
    next.rate === snapshot.rate &&
    next.channels === snapshot.channels &&
    next.level === snapshot.level
  ) {
    return
  }
  snapshot = next
  for (const fn of listeners) fn()
}
