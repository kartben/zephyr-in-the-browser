/**
 * Browser wrapper around the vendored google/libsbc WASM build
 * (`public/vendor/libsbc/sbc.umd.cjs`). Decodes A2DP SBC frames to interleaved
 * Int16 PCM for Web Audio.
 */

export interface SbcProbe {
  frameSize: number
  sampleRate: number
  channels: number
  /** Samples per channel in one frame. */
  samplesPerChannel: number
}

export interface SbcDecodedFrame {
  pcm: Int16Array
  sampleRate: number
  channels: number
}

type SbcModule = {
  _sbc_wasm_reset: () => void
  _sbc_wasm_probe: (data: number, freqHz: number, nch: number, ns: number) => number
  _sbc_wasm_decode_frame: (data: number, size: number, pcm: number) => number
  _sbc_wasm_max_pcm_samples: () => number
  _malloc: (n: number) => number
  _free: (p: number) => void
  HEAPU8: Uint8Array
  HEAP16: Int16Array
  getValue: (ptr: number, type: string) => number
}

type CreateSbcModule = (opts?: Record<string, unknown>) => Promise<SbcModule>

const SBC_URL = `${import.meta.env.BASE_URL}vendor/libsbc/sbc.umd.cjs`

let modulePromise: Promise<SbcModule> | null = null
let mod: SbcModule | null = null
let freqPtr = 0
let chPtr = 0
let nsPtr = 0
let pcmPtr = 0
let inCap = 0
let inPtr = 0

async function loadModule(): Promise<SbcModule> {
  if (mod) return mod
  if (!modulePromise) {
    modulePromise = (async () => {
      // Emscripten MODULARIZE UMD — load as a classic script, then call the factory.
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>('script[data-libsbc]')
        if (existing) {
          if ((globalThis as { createSbcModule?: CreateSbcModule }).createSbcModule) {
            resolve()
            return
          }
          existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('libsbc sbc.umd.cjs failed')), {
          once: true,
        })
        return
      }
      const script = document.createElement('script')
      script.src = SBC_URL
      script.async = true
      script.dataset.libsbc = '1'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`failed to load ${SBC_URL}`))
      document.head.appendChild(script)
    })
    const factory = (globalThis as unknown as { createSbcModule?: CreateSbcModule }).createSbcModule
    if (typeof factory !== 'function') {
      throw new Error('createSbcModule missing after loading sbc.umd.cjs')
    }
      const m = await factory()
      m._sbc_wasm_reset()
      freqPtr = m._malloc(4)
      chPtr = m._malloc(4)
      nsPtr = m._malloc(4)
      const maxSamples = m._sbc_wasm_max_pcm_samples()
      pcmPtr = m._malloc(maxSamples * 2)
      mod = m
      return m
    })()
  }
  return modulePromise
}

/** Node/vitest path: require the UMD build directly without DOM script tags. */
export async function loadSbcModuleForTests(create: CreateSbcModule): Promise<void> {
  const m = await create()
  m._sbc_wasm_reset()
  freqPtr = m._malloc(4)
  chPtr = m._malloc(4)
  nsPtr = m._malloc(4)
  pcmPtr = m._malloc(m._sbc_wasm_max_pcm_samples() * 2)
  mod = m
  modulePromise = Promise.resolve(m)
}

function ensureInBuf(m: SbcModule, need: number) {
  if (need <= inCap) return
  if (inPtr) m._free(inPtr)
  inCap = Math.max(need, 4096)
  inPtr = m._malloc(inCap)
}

function probeAt(m: SbcModule, dataPtr: number): SbcProbe | null {
  const frameSize = m._sbc_wasm_probe(dataPtr, freqPtr, chPtr, nsPtr)
  if (frameSize <= 0) return null
  return {
    frameSize,
    sampleRate: m.getValue(freqPtr, 'i32'),
    channels: m.getValue(chPtr, 'i32'),
    samplesPerChannel: m.getValue(nsPtr, 'i32'),
  }
}

/**
 * Decode a contiguous SBC bitstream (one or more frames, no A2DP media header).
 */
export async function decodeSbcBitstream(data: Uint8Array): Promise<SbcDecodedFrame[]> {
  const m = await loadModule()
  ensureInBuf(m, data.length)
  m.HEAPU8.set(data, inPtr)

  const out: SbcDecodedFrame[] = []
  let off = 0
  while (off + 4 <= data.length) {
    const info = probeAt(m, inPtr + off)
    if (!info || off + info.frameSize > data.length) break
    const n = m._sbc_wasm_decode_frame(inPtr + off, info.frameSize, pcmPtr)
    if (n < 0) break
    const pcm = new Int16Array(n)
    pcm.set(m.HEAP16.subarray(pcmPtr >> 1, (pcmPtr >> 1) + n))
    out.push({ pcm, sampleRate: info.sampleRate, channels: info.channels })
    off += info.frameSize
  }
  return out
}

/**
 * Strip the 1-byte A2DP media payload header, then decode the enclosed SBC frames.
 * Bumble's RTP `packet.payload` is header + frames; Hive's extractor keeps frames only.
 */
export async function decodeA2dpSbcPayload(payload: Uint8Array): Promise<SbcDecodedFrame[]> {
  if (payload.length < 2) return []
  // Media payload header: F/S/L/RFA + number_of_frames in low nibble.
  return decodeSbcBitstream(payload.subarray(1))
}

export function resetSbcDecoderForTests() {
  mod = null
  modulePromise = null
  freqPtr = chPtr = nsPtr = pcmPtr = inPtr = inCap = 0
}
