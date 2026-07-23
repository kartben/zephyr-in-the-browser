/** ICMP echo (RFC 792) — just enough for `net ping`. */

import { checksum16, viewOf } from './bytes'

export const ICMP_ECHO_REPLY = 0
export const ICMP_ECHO_REQUEST = 8

export interface IcmpPacket {
  type: number
  code: number
  id: number
  seq: number
  payload: Uint8Array
}

export function parseIcmp(payload: Uint8Array): IcmpPacket | null {
  if (payload.length < 8) return null
  const view = viewOf(payload)
  return {
    type: payload[0],
    code: payload[1],
    id: view.getUint16(4),
    seq: view.getUint16(6),
    payload: payload.subarray(8),
  }
}

export function buildIcmp(packet: IcmpPacket): Uint8Array {
  const out = new Uint8Array(8 + packet.payload.length)
  const view = viewOf(out)
  out[0] = packet.type
  out[1] = packet.code
  view.setUint16(4, packet.id)
  view.setUint16(6, packet.seq)
  out.set(packet.payload, 8)
  view.setUint16(2, checksum16(out))
  return out
}

export function buildEchoReply(request: IcmpPacket): Uint8Array {
  return buildIcmp({ ...request, type: ICMP_ECHO_REPLY, code: 0 })
}
