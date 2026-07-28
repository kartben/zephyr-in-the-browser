import { describe, expect, it } from 'vitest'
import { H4_ACL, H4_CMD, H4_EVT, H4Framer } from '@/bt/h4'

describe('H4Framer', () => {
  it('reassembles a command split across chunks', () => {
    const framer = new H4Framer()
    // HCI Reset: type=CMD, opcode=0x0c03, plen=0
    const packet = Uint8Array.of(H4_CMD, 0x03, 0x0c, 0x00)
    expect(framer.push(packet.subarray(0, 2))).toEqual([])
    const out = framer.push(packet.subarray(2))
    expect(out).toHaveLength(1)
    expect(Array.from(out[0]!)).toEqual([H4_CMD, 0x03, 0x0c, 0x00])
  })

  it('parses an event with payload', () => {
    const framer = new H4Framer()
    // Command Complete for Reset: evt=0x0e, plen=4, ncmd=1, opcode, status
    const packet = Uint8Array.of(H4_EVT, 0x0e, 0x04, 0x01, 0x03, 0x0c, 0x00)
    expect(Array.from(framer.push(packet)[0]!)).toEqual(Array.from(packet))
  })

  it('parses ACL length as little-endian', () => {
    const framer = new H4Framer()
    const payload = Uint8Array.of(0xaa, 0xbb, 0xcc)
    const packet = new Uint8Array(1 + 4 + payload.length)
    packet[0] = H4_ACL
    packet[1] = 0x00
    packet[2] = 0x00
    packet[3] = payload.length & 0xff
    packet[4] = (payload.length >> 8) & 0xff
    packet.set(payload, 5)
    expect(framer.push(packet)).toHaveLength(1)
  })

  it('drops an unknown type byte and resyncs', () => {
    const framer = new H4Framer()
    const good = Uint8Array.of(H4_CMD, 0x03, 0x0c, 0x00)
    const junk = new Uint8Array([0xff, ...good])
    const out = framer.push(junk)
    expect(out).toHaveLength(1)
    expect(Array.from(out[0]!)).toEqual(Array.from(good))
  })
})
