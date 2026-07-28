import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeSbcBitstream,
  loadSbcModuleForTests,
  resetSbcDecoderForTests,
} from '@/bt/sbcDecoder'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const createSbcModule = require(join(root, 'public/vendor/libsbc/sbc.umd.cjs')) as (
  opts?: Record<string, unknown>,
) => Promise<unknown>

describe('sbcDecoder', () => {
  afterEach(() => resetSbcDecoderForTests())

  it('decodes a 44.1 kHz stereo SBC fixture to PCM', async () => {
    await loadSbcModuleForTests(createSbcModule as never)
    const sbc = new Uint8Array(readFileSync(join(root, 'src/bt/testdata/tone44100.sbc')))
    const frames = await decodeSbcBitstream(sbc)
    expect(frames.length).toBeGreaterThan(10)
    expect(frames[0]!.sampleRate).toBe(44100)
    expect(frames[0]!.channels).toBe(2)
    // 100 ms of 128 samples/channel/frame at 44.1k → ~34 frames
    const totalInterleaved = frames.reduce((n, f) => n + f.pcm.length, 0)
    expect(totalInterleaved).toBeGreaterThan(8000)
    let peak = 0
    for (const s of frames[0]!.pcm) peak = Math.max(peak, Math.abs(s))
    expect(peak).toBeGreaterThan(1000)
  })
})
