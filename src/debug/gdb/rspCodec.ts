/**
 * GDB Remote Serial Protocol framing: `$payload#CS` plus ack bytes.
 *
 * Checksum is the sum of payload bytes modulo 256, as two lowercase hex digits.
 */

export function checksum(payload: string): string {
  let sum = 0
  for (let i = 0; i < payload.length; i++) sum = (sum + payload.charCodeAt(i)) & 0xff
  return sum.toString(16).padStart(2, '0')
}

/** Encode a packet body into `$…#CS`. */
export function encodePacket(payload: string): string {
  return `$${payload}#${checksum(payload)}`
}

export type Decoded =
  | { kind: 'ack' }
  | { kind: 'nack' }
  | { kind: 'packet'; payload: string }
  | { kind: 'break' }

/**
 * Pull complete messages from a growing byte buffer.
 * Returns decoded messages and the unconsumed tail (may hold a partial packet).
 */
export function decodeStream(buffer: string): { messages: Decoded[]; rest: string } {
  const messages: Decoded[] = []
  let i = 0
  while (i < buffer.length) {
    const ch = buffer[i]!
    if (ch === '+') {
      messages.push({ kind: 'ack' })
      i++
      continue
    }
    if (ch === '-') {
      messages.push({ kind: 'nack' })
      i++
      continue
    }
    if (ch === '$') {
      const hash = buffer.indexOf('#', i + 1)
      if (hash < 0 || hash + 2 >= buffer.length) break // incomplete
      const payload = buffer.slice(i + 1, hash)
      const cs = buffer.slice(hash + 1, hash + 3).toLowerCase()
      if (cs.length < 2) break
      if (checksum(payload) === cs) messages.push({ kind: 'packet', payload })
      else messages.push({ kind: 'nack' }) // treat bad CS as nack for the caller
      i = hash + 3
      continue
    }
    // Ignore unexpected noise (e.g. leftover newlines).
    i++
  }
  return { messages, rest: buffer.slice(i) }
}

/** Hex-encode bytes little-endian register style (each byte → 2 hex chars). */
export function bytesToHex(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i++) out += data[i]!.toString(16).padStart(2, '0')
  return out
}

/** Decode a contiguous hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length % 2 !== 0) throw new Error('odd hex length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
