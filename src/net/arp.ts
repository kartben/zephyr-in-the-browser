/** ARP over Ethernet/IPv4 (RFC 826). */

import { viewOf } from './bytes'

export const ARP_REQUEST = 1
export const ARP_REPLY = 2

export interface ArpPacket {
  op: number
  senderMac: Uint8Array
  senderIp: number
  targetMac: Uint8Array
  targetIp: number
}

export function parseArp(payload: Uint8Array): ArpPacket | null {
  if (payload.length < 28) return null
  const view = viewOf(payload)
  // Only Ethernet (1) + IPv4 (0x0800) with the standard address sizes.
  if (view.getUint16(0) !== 1 || view.getUint16(2) !== 0x0800) return null
  if (payload[4] !== 6 || payload[5] !== 4) return null
  return {
    op: view.getUint16(6),
    senderMac: payload.subarray(8, 14),
    senderIp: view.getUint32(14),
    targetMac: payload.subarray(18, 24),
    targetIp: view.getUint32(24),
  }
}

export function buildArp(packet: ArpPacket): Uint8Array {
  const out = new Uint8Array(28)
  const view = viewOf(out)
  view.setUint16(0, 1) // Ethernet
  view.setUint16(2, 0x0800) // IPv4
  out[4] = 6
  out[5] = 4
  view.setUint16(6, packet.op)
  out.set(packet.senderMac, 8)
  view.setUint32(14, packet.senderIp)
  out.set(packet.targetMac, 18)
  view.setUint32(24, packet.targetIp)
  return out
}
