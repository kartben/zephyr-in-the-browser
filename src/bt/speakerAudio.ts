/**
 * Web Audio sink for the in-page A2DP speaker peer.
 *
 * Decodes SBC (via {@link ./sbcDecoder}) and schedules PCM on an AudioContext.
 * Autoplay policy requires {@link enable} from a user gesture before sound
 * leaves the speakers — same rule as {@link ../hostAudio}.
 */

import { decodeA2dpSbcPayload, decodeSbcBitstream } from '@/bt/sbcDecoder'

export interface SpeakerAudioSnapshot {
  enabled: boolean
  /** Peak of the most recent decoded chunk, 0..1. */
  level: number
  framesDecoded: number
  lastError: string
}

const LEAD_SECONDS = 0.08
const listeners = new Set<() => void>()

let snapshot: SpeakerAudioSnapshot = {
  enabled: false,
  level: 0,
  framesDecoded: 0,
  lastError: '',
}

let ctx: AudioContext | null = null
let playhead = 0
let mutedPeers = new Set<string>()

function setSnapshot(patch: Partial<SpeakerAudioSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): SpeakerAudioSnapshot {
  return snapshot
}

/** Must run from a click — resumes/creates the AudioContext. */
export async function enable(): Promise<void> {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  playhead = ctx.currentTime + LEAD_SECONDS
  setSnapshot({ enabled: true, lastError: '' })
}

export function disable() {
  void ctx?.suspend()
  setSnapshot({ enabled: false, level: 0 })
}

export function setPeerMuted(peerId: string, muted: boolean) {
  if (muted) mutedPeers.add(peerId)
  else mutedPeers.delete(peerId)
}

/**
 * Called from the Bumble bridge with an A2DP media payload (header + SBC frames)
 * or a raw SBC bitstream when `raw` is true.
 */
export function onSpeakerPacket(peerId: string, payload: Uint8Array, raw = false) {
  if (mutedPeers.has(peerId)) return
  if (!snapshot.enabled || !ctx) return
  void (async () => {
    try {
      const frames = raw ? await decodeSbcBitstream(payload) : await decodeA2dpSbcPayload(payload)
      for (const frame of frames) enqueuePcm(frame.pcm, frame.sampleRate, frame.channels)
      if (frames.length) {
        setSnapshot({
          framesDecoded: snapshot.framesDecoded + frames.length,
          lastError: '',
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSnapshot({ lastError: message })
      console.warn('[bt] speaker decode failed', err)
    }
  })()
}

function enqueuePcm(pcm: Int16Array, sampleRate: number, channels: number) {
  if (!ctx || !snapshot.enabled) return
  const frames = Math.floor(pcm.length / channels)
  if (frames <= 0) return

  const buffer = ctx.createBuffer(channels, frames, sampleRate)
  let peak = 0
  for (let ch = 0; ch < channels; ch++) {
    const plane = buffer.getChannelData(ch)
    for (let i = 0; i < frames; i++) {
      const s = pcm[i * channels + ch]! / 32768
      plane[i] = s
      const a = Math.abs(s)
      if (a > peak) peak = a
    }
  }

  const now = ctx.currentTime
  if (playhead < now) playhead = now + LEAD_SECONDS
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(playhead)
  playhead += frames / sampleRate
  setSnapshot({ level: peak })
}
