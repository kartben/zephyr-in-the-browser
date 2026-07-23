/** IPv4 headers (RFC 791). No fragmentation: the stack's MSS keeps every
 * datagram under the Ethernet MTU, and fragmented ingress is dropped. */

import { checksum16, viewOf } from './bytes'

export const IPPROTO_ICMP = 1
export const IPPROTO_TCP = 6
export const IPPROTO_UDP = 17

export interface Ipv4Packet {
  src: number
  dst: number
  proto: number
  ttl: number
  payload: Uint8Array
}

let ipIdCounter = 0

export function parseIpv4(payload: Uint8Array): Ipv4Packet | null {
  if (payload.length < 20) return null
  const view = viewOf(payload)
  const version = payload[0] >>> 4
  const ihl = (payload[0] & 0x0f) * 4
  if (version !== 4 || ihl < 20 || payload.length < ihl) return null
  const totalLength = view.getUint16(2)
  if (totalLength < ihl || totalLength > payload.length) return null
  const flagsFrag = view.getUint16(6)
  // MF set or a fragment offset: reassembly is out of scope.
  if ((flagsFrag & 0x2000) !== 0 || (flagsFrag & 0x1fff) !== 0) return null
  return {
    src: view.getUint32(12),
    dst: view.getUint32(16),
    proto: payload[9],
    ttl: payload[8],
    payload: payload.subarray(ihl, totalLength),
  }
}

export function buildIpv4(
  src: number,
  dst: number,
  proto: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(20 + payload.length)
  const view = viewOf(out)
  out[0] = 0x45 // v4, 20-byte header
  view.setUint16(2, out.length)
  view.setUint16(4, ipIdCounter++ & 0xffff)
  view.setUint16(6, 0x4000) // DF
  out[8] = 64 // TTL
  out[9] = proto
  view.setUint32(12, src)
  view.setUint32(16, dst)
  view.setUint16(10, checksum16(out.subarray(0, 20)))
  out.set(payload, 20)
  return out
}
