/** UDP (RFC 768). */

import { checksum16, pseudoHeaderSum, viewOf } from './bytes'
import { IPPROTO_UDP } from './ipv4'

export interface UdpDatagram {
  srcPort: number
  dstPort: number
  payload: Uint8Array
}

export function parseUdp(payload: Uint8Array): UdpDatagram | null {
  if (payload.length < 8) return null
  const view = viewOf(payload)
  const length = view.getUint16(4)
  if (length < 8 || length > payload.length) return null
  return {
    srcPort: view.getUint16(0),
    dstPort: view.getUint16(2),
    payload: payload.subarray(8, length),
  }
}

export function buildUdp(
  srcIp: number,
  dstIp: number,
  srcPort: number,
  dstPort: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = viewOf(out)
  view.setUint16(0, srcPort)
  view.setUint16(2, dstPort)
  view.setUint16(4, out.length)
  out.set(payload, 8)
  let sum = checksum16(out, pseudoHeaderSum(srcIp, dstIp, IPPROTO_UDP, out.length))
  if (sum === 0) sum = 0xffff // 0 means "no checksum" on the wire
  view.setUint16(6, sum)
  return out
}
