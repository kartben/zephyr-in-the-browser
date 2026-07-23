/** SNTP server (RFC 4330) answering with the browser's clock. */

import { viewOf } from './bytes'

export const SNTP_PORT = 123

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_UNIX_OFFSET = 2208988800

export function isSntpRequest(payload: Uint8Array): boolean {
  if (payload.length < 48) return false
  const mode = payload[0] & 0x07
  return mode === 3 // client
}

export function buildSntpReply(request: Uint8Array, nowMs: number): Uint8Array {
  const out = new Uint8Array(48)
  const view = viewOf(out)
  const vn = (request[0] >>> 3) & 0x07
  out[0] = (vn << 3) | 4 // LI 0, server mode
  out[1] = 1 // stratum 1: we *are* the reference clock here
  out[2] = 6 // poll
  out[3] = 0xec // precision ~1 us, conventional value
  // Reference ID: "GOOG"-style ASCII is for real servers; use "WASM".
  out.set([0x57, 0x41, 0x53, 0x4d], 12)

  const secs = Math.floor(nowMs / 1000) + NTP_UNIX_OFFSET
  const frac = Math.floor(((nowMs % 1000) / 1000) * 2 ** 32)
  const stamp = (offset: number) => {
    view.setUint32(offset, secs >>> 0)
    view.setUint32(offset + 4, frac >>> 0)
  }
  stamp(16) // reference
  // Originate := the client's transmit timestamp, echoed back.
  out.set(request.subarray(40, 48), 24)
  stamp(32) // receive
  stamp(40) // transmit
  return out
}
