/**
 * Browser end of the `qemu,host-mic` bridge — the input twin of hostAudio.
 *
 * The QEMU device owns a ring of 16-bit mono PCM at a fixed rate (16 kHz)
 * that the *browser* fills and the guest's DMIC driver drains. Captured
 * microphone audio is resampled to the device rate, written straight into the
 * shared Emscripten heap at the exported ring address, and published by
 * advancing the write index; the guest pops samples over MMIO on its side.
 *
 * Capture requires a getUserMedia grant, so enable() must run from a user
 * gesture (the panel's mic button). While disabled nothing is written and the
 * guest driver reads silence — its choice, not ours, which is what keeps the
 * stock dmic sample running with or without a microphone.
 *
 * Like hostGpio, deliberately not part of the PtyBackend seam: the bridge is
 * optional, and a backend with no mic device need not know it exists.
 */

interface MicExports {
  _qemu_host_mic_get_rate?: () => number
  _qemu_host_mic_get_buffer_samples?: () => number
  _qemu_host_mic_get_data?: () => number
  _qemu_host_mic_get_read_index?: () => number
  _qemu_host_mic_set_write_index?: (index: number) => void
  /** Shared-memory view emitted by Emscripten's pthread runtime. */
  HEAPU8?: Uint8Array
}

export interface MicSnapshot {
  available: boolean
  /** Microphone is granted and streaming into the ring. */
  enabled: boolean
  /** Device sample rate in Hz, 0 until attached. */
  rate: number
  /** Peak of the most recent capture chunk, 0..1, for a level meter. */
  level: number
  /** Set when the user denied the permission (or capture failed). */
  error: string | null
}

const EMPTY: MicSnapshot = {
  available: false,
  enabled: false,
  rate: 0,
  level: 0,
  error: null,
}

let exports: MicExports | null = null
const listeners = new Set<() => void>()

let snapshot = EMPTY
let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let processor: ScriptProcessorNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let sink: GainNode | null = null
let enabled = false
let error: string | null = null
/** Samples produced so far, mirroring the device's free-running counter. */
let writeIndex = 0
/** Fractional read position into the capture stream, for resampling. */
let resamplePos = 0

export function attach(mod: unknown) {
  detach()
  exports = mod as MicExports
  if (available()) {
    writeIndex = 0
  }
  update()
}

export function detach() {
  stopCapture()
  exports = null
  error = null
  writeIndex = 0
  update()
}

export function available(): boolean {
  return (
    typeof exports?._qemu_host_mic_get_rate === 'function' &&
    typeof exports?._qemu_host_mic_get_buffer_samples === 'function' &&
    typeof exports?._qemu_host_mic_get_data === 'function' &&
    typeof exports?._qemu_host_mic_get_read_index === 'function' &&
    typeof exports?._qemu_host_mic_set_write_index === 'function' &&
    exports?.HEAPU8 !== undefined
  )
}

/** Must be called from a user gesture: it triggers the permission prompt. */
export async function enable() {
  if (!available() || enabled) return
  error = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    error = 'Microphone access was denied.'
    update()
    return
  }
  ctx = new AudioContext()
  void ctx.resume()
  source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but universal, and 4096 frames of latency
  // (~85 ms at 48 kHz) is irrelevant next to the guest's 100 ms block reads.
  processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = onCapture
  // A muted sink keeps the processor scheduled without feeding the speakers.
  sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(processor)
  processor.connect(sink)
  sink.connect(ctx.destination)
  resamplePos = 0
  enabled = true
  update()
}

export function disable() {
  if (!enabled) return
  stopCapture()
  update()
}

export function toggle() {
  if (enabled) void disable()
  else void enable()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): MicSnapshot {
  return snapshot
}

function stopCapture() {
  processor?.disconnect()
  source?.disconnect()
  sink?.disconnect()
  for (const track of stream?.getTracks() ?? []) track.stop()
  void ctx?.close()
  processor = null
  source = null
  sink = null
  stream = null
  ctx = null
  enabled = false
}

function onCapture(event: AudioProcessingEvent) {
  if (!available() || !exports || !ctx) return
  const heap = exports.HEAPU8!
  const rate = exports._qemu_host_mic_get_rate!()
  const capacity = exports._qemu_host_mic_get_buffer_samples!()
  const data = exports._qemu_host_mic_get_data!()
  const input = event.inputBuffer.getChannelData(0)
  if (rate <= 0) return

  // Naive linear resample from the capture rate down to the device rate —
  // fine for speech into a 16 kHz ring.
  const ratio = ctx.sampleRate / rate
  let peak = 0
  let produced = 0
  while (resamplePos < input.length - 1) {
    const i = Math.floor(resamplePos)
    const frac = resamplePos - i
    const value = input[i]! * (1 - frac) + input[i + 1]! * frac
    const mag = Math.abs(value)
    if (mag > peak) peak = mag

    // Never run more than a ring ahead of the guest; drop when it lags —
    // the guest resyncs its read index on capture start anyway.
    const readIndex = exports._qemu_host_mic_get_read_index!() >>> 0
    if (((writeIndex - readIndex) >>> 0) < capacity) {
      const clamped = Math.max(-1, Math.min(1, value))
      const raw = Math.round(clamped * 32767) & 0xffff
      const pos = (writeIndex & (capacity - 1)) * 2
      heap[data + pos] = raw & 0xff
      heap[data + pos + 1] = raw >> 8
      writeIndex = (writeIndex + 1) >>> 0
      produced++
    }
    resamplePos += ratio
  }
  resamplePos -= input.length
  if (produced > 0) {
    exports._qemu_host_mic_set_write_index!(writeIndex)
  }
  update(peak)
}

function update(level?: number) {
  const next: MicSnapshot = {
    available: available(),
    enabled,
    rate: available() ? exports!._qemu_host_mic_get_rate!() : 0,
    // Quantised so sustained input does not re-render the panel constantly.
    level: Math.round((enabled ? (level ?? snapshot.level) : 0) * 20) / 20,
    error,
  }
  if (
    next.available === snapshot.available &&
    next.enabled === snapshot.enabled &&
    next.rate === snapshot.rate &&
    next.level === snapshot.level &&
    next.error === snapshot.error
  ) {
    return
  }
  snapshot = next
  for (const fn of listeners) fn()
}
