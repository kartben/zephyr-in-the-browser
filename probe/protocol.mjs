/**
 * Probe-bridge wire protocol.
 *
 * Each WebSocket *binary* message is one frame:
 *   u8 channel | payload…
 *
 * Channels:
 *   0x01 CTF   — daemon → page (raw Zephyr CTF bytes)
 *   0x02 GDB   — bidirectional GDB RSP bytes
 *   0x10 CTRL  — UTF-8 JSON control messages either way
 *
 * Text frames are ignored. Control messages are documented in
 * docs/probe-bridge.md.
 */

export const CH_CTF = 0x01
export const CH_GDB = 0x02
export const CH_CTRL = 0x10

export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_FULL = 4002
export const CLOSE_BACKEND_FAILED = 4003
export const CLOSE_BACKEND_DIED = 1011
export const CLOSE_GOING_AWAY = 1001

/** @param {number} channel @param {Uint8Array|Buffer|string} payload */
export function encodeFrame(channel, payload) {
  let body
  if (typeof payload === 'string') {
    body = Buffer.from(payload, 'utf8')
  } else if (Buffer.isBuffer(payload)) {
    body = payload
  } else {
    body = Buffer.from(payload)
  }
  const out = Buffer.allocUnsafe(1 + body.length)
  out[0] = channel & 0xff
  body.copy(out, 1)
  return out
}

/** @param {Buffer|Uint8Array|ArrayBuffer} raw */
export function decodeFrame(raw) {
  const buf = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw)
  if (buf.length < 1) return null
  return { channel: buf[0], payload: buf.subarray(1) }
}

export function encodeCtrl(obj) {
  return encodeFrame(CH_CTRL, JSON.stringify(obj))
}

/** @param {Buffer|Uint8Array} payload */
export function decodeCtrl(payload) {
  const text = Buffer.from(payload).toString('utf8')
  return JSON.parse(text)
}
