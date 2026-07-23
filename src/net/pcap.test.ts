import { describe, expect, it } from 'vitest'
import { writePcap } from './pcap'

describe('pcap', () => {
  it('writes a classic pcap header and records', () => {
    const frame1 = Uint8Array.from({ length: 60 }, (_, i) => i)
    const frame2 = Uint8Array.of(1, 2, 3, 4)
    const out = writePcap([
      { ts: 1_700_000_000_123, data: frame1 },
      { ts: 1_700_000_001_456, data: frame2 },
    ])
    const view = new DataView(out.buffer)
    expect(view.getUint32(0)).toBe(0xa1b2c3d4)
    expect(view.getUint16(4)).toBe(2)
    expect(view.getUint16(6)).toBe(4)
    expect(view.getUint32(20)).toBe(1) // LINKTYPE_ETHERNET

    // Record 1.
    expect(view.getUint32(24)).toBe(1_700_000_000)
    expect(view.getUint32(28)).toBe(123_000)
    expect(view.getUint32(32)).toBe(60)
    expect(view.getUint32(36)).toBe(60)
    expect(out[40 + 5]).toBe(5)

    // Record 2 follows immediately.
    const r2 = 24 + 16 + 60
    expect(view.getUint32(r2)).toBe(1_700_000_001)
    expect(view.getUint32(r2 + 8)).toBe(4)
    expect(out.length).toBe(r2 + 16 + 4)
  })
})
