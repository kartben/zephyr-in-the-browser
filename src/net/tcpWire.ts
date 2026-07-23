/** TCP segment codec (RFC 9293 wire format) — the engine lives in tcp.ts. */

import { checksum16, pseudoHeaderSum, viewOf } from './bytes'
import { IPPROTO_TCP } from './ipv4'

export const TCP_FIN = 0x01
export const TCP_SYN = 0x02
export const TCP_RST = 0x04
export const TCP_PSH = 0x08
export const TCP_ACK = 0x10

export interface TcpSegment {
  srcPort: number
  dstPort: number
  /** Unsigned 32-bit sequence / ack numbers. */
  seq: number
  ack: number
  flags: number
  window: number
  payload: Uint8Array
  /** MSS option value, when present (SYN segments). */
  mss?: number
}

export function parseTcpSegment(payload: Uint8Array): TcpSegment | null {
  if (payload.length < 20) return null
  const view = viewOf(payload)
  const dataOff = (payload[12] >>> 4) * 4
  if (dataOff < 20 || dataOff > payload.length) return null

  let mss: number | undefined
  let i = 20
  while (i < dataOff) {
    const kind = payload[i]
    if (kind === 0) break // end of options
    if (kind === 1) {
      i += 1 // NOP
      continue
    }
    if (i + 1 >= dataOff) break
    const len = payload[i + 1]
    if (len < 2 || i + len > dataOff) break
    if (kind === 2 && len === 4) mss = view.getUint16(i + 2)
    i += len
  }

  return {
    srcPort: view.getUint16(0),
    dstPort: view.getUint16(2),
    seq: view.getUint32(4),
    ack: view.getUint32(8),
    flags: payload[13] & 0x3f,
    window: view.getUint16(14),
    payload: payload.subarray(dataOff),
    mss,
  }
}

export function buildTcpSegment(srcIp: number, dstIp: number, seg: TcpSegment): Uint8Array {
  const optLen = seg.mss !== undefined ? 4 : 0
  const headerLen = 20 + optLen
  const out = new Uint8Array(headerLen + seg.payload.length)
  const view = viewOf(out)
  view.setUint16(0, seg.srcPort)
  view.setUint16(2, seg.dstPort)
  view.setUint32(4, seg.seq >>> 0)
  view.setUint32(8, seg.ack >>> 0)
  out[12] = (headerLen / 4) << 4
  out[13] = seg.flags & 0x3f
  view.setUint16(14, seg.window)
  if (seg.mss !== undefined) {
    out[20] = 2
    out[21] = 4
    view.setUint16(22, seg.mss)
  }
  out.set(seg.payload, headerLen)
  view.setUint16(16, checksum16(out, pseudoHeaderSum(srcIp, dstIp, IPPROTO_TCP, out.length)))
  return out
}

/** Human-readable flag string, e.g. "SYN,ACK". */
export function tcpFlagsToString(flags: number): string {
  const names: Array<[number, string]> = [
    [TCP_SYN, 'SYN'],
    [TCP_FIN, 'FIN'],
    [TCP_RST, 'RST'],
    [TCP_PSH, 'PSH'],
    [TCP_ACK, 'ACK'],
  ]
  const set = names.filter(([bit]) => flags & bit).map(([, name]) => name)
  return set.length > 0 ? set.join(',') : 'none'
}
