import { describe, expect, it } from 'vitest'
import { CH_CTF, CH_CTRL, decodeCtrl, decodeFrame, encodeCtrl, encodeFrame } from './protocol'

describe('probe protocol', () => {
  it('round-trips CTF frames', () => {
    const frame = encodeFrame(CH_CTF, new Uint8Array([1, 2, 3]))
    const d = decodeFrame(frame)
    expect(d?.channel).toBe(CH_CTF)
    expect([...d!.payload]).toEqual([1, 2, 3])
  })

  it('round-trips control JSON', () => {
    const frame = encodeCtrl({ type: 'hello', version: 1 })
    const d = decodeFrame(frame)
    expect(d?.channel).toBe(CH_CTRL)
    expect(decodeCtrl(d!.payload)).toEqual({ type: 'hello', version: 1 })
  })
})
