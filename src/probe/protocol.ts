/**
 * Probe/uber-bridge wire frames (mirrors bridge/protocol.mjs).
 */

export const CH_CTF = 0x01
export const CH_GDB = 0x02
export const CH_NET = 0x03
export const CH_CTRL = 0x10

export function encodeFrame(channel: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const out = new Uint8Array(1 + body.length)
  out[0] = channel & 0xff
  out.set(body, 1)
  return out
}

export function decodeFrame(
  raw: ArrayBuffer | Uint8Array,
): { channel: number; payload: Uint8Array } | null {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  if (buf.length < 1) return null
  return { channel: buf[0]!, payload: buf.subarray(1) }
}

export function encodeCtrl(obj: unknown): Uint8Array {
  return encodeFrame(CH_CTRL, JSON.stringify(obj))
}

export function decodeCtrl(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(payload))
}

export type ProbePortInfo = {
  path: string
  manufacturer: string | null
  serialNumber: string | null
  vendorId: string | null
  productId: string | null
  friendlyName: string
}

export type SerialStatus = {
  path: string | null
  baudRate: number
  phase: string
  detail: string
}

export type GdbStatus = {
  host: string
  port: number
  phase: string
  detail: string
}

export type BridgeFeatures = {
  ctf: boolean
  gdb: boolean
  net: boolean
}
