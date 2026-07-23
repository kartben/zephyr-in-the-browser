/** Ethernet II framing. */

import { concat, viewOf } from './bytes'

export const ETHERTYPE_IPV4 = 0x0800
export const ETHERTYPE_ARP = 0x0806
export const ETHERTYPE_IPV6 = 0x86dd

export interface EthFrame {
  dst: Uint8Array
  src: Uint8Array
  etherType: number
  payload: Uint8Array
}

export function parseEth(frame: Uint8Array): EthFrame | null {
  if (frame.length < 14) return null
  const view = viewOf(frame)
  return {
    dst: frame.subarray(0, 6),
    src: frame.subarray(6, 12),
    etherType: view.getUint16(12),
    payload: frame.subarray(14),
  }
}

export function buildEth(
  dst: Uint8Array,
  src: Uint8Array,
  etherType: number,
  payload: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(14)
  header.set(dst, 0)
  header.set(src, 6)
  header[12] = etherType >>> 8
  header[13] = etherType & 0xff
  return concat(header, payload)
}
