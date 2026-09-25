import { describe, expect, it } from 'vitest'
import { trimEthernetPadding } from './uplink'

/** 60-byte frame as the guest NIC pads it: IPv4, tot_len 40, 6 pad octets. */
function paddedIpv4Frame(totLen = 40): Uint8Array {
  const f = new Uint8Array(60).fill(0x11)
  f[12] = 0x08
  f[13] = 0x00
  f[14] = 0x45
  f[16] = (totLen >> 8) & 0xff
  f[17] = totLen & 0xff
  return f
}

describe('trimEthernetPadding', () => {
  it('trims a 60-byte padded frame to header + IP total length', () => {
    const out = trimEthernetPadding(paddedIpv4Frame(40))
    expect(out).toHaveLength(54)
    expect(out).toEqual(paddedIpv4Frame(40).subarray(0, 54))
  })

  it('leaves exact-length frames alone', () => {
    const f = paddedIpv4Frame(46) // 14 + 46 = 60: nothing to trim
    expect(trimEthernetPadding(f)).toBe(f)
  })

  it('ignores non-IPv4 ethertypes even at padded sizes', () => {
    const arp = paddedIpv4Frame(40)
    arp[12] = 0x08
    arp[13] = 0x06
    expect(trimEthernetPadding(arp)).toBe(arp)
  })

  it('ignores runts and frames whose claimed length is implausible', () => {
    expect(trimEthernetPadding(new Uint8Array(20))).toHaveLength(20)
    const tooShort = paddedIpv4Frame(8) // tot_len below an IPv4 header
    expect(trimEthernetPadding(tooShort)).toBe(tooShort)
    const tooLong = paddedIpv4Frame(200) // claims more than the frame holds
    expect(trimEthernetPadding(tooLong)).toBe(tooLong)
  })
})
