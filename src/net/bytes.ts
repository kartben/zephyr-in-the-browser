/**
 * Byte-level primitives shared by every codec in src/net/.
 *
 * IPv4 addresses travel as unsigned 32-bit numbers (cheap Map keys, cheap
 * compares); MACs as 6-byte Uint8Arrays. Strings appear only at the UI
 * boundary.
 */

/** Ones'-complement 16-bit checksum over `data`, seeded with `initial`. */
export function checksum16(data: Uint8Array, initial = 0): number {
  let sum = initial
  const even = data.length & ~1
  for (let i = 0; i < even; i += 2) sum += (data[i] << 8) | data[i + 1]
  if (data.length & 1) sum += data[data.length - 1] << 8
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16)
  return ~sum & 0xffff
}

/**
 * The TCP/UDP pseudo-header contribution: pass as `initial` to checksum16 of
 * the transport segment. Returns an un-folded partial sum.
 */
export function pseudoHeaderSum(src: number, dst: number, proto: number, length: number): number {
  return (
    (src >>> 16) +
    (src & 0xffff) +
    (dst >>> 16) +
    (dst & 0xffff) +
    proto +
    length
  )
}

export function ipToString(ip: number): string {
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`
}

/** "a.b.c.d" -> u32, or null when malformed. */
export function ipFromString(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim())
  if (!m) return null
  let ip = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    ip = ((ip << 8) | octet) >>> 0
  }
  return ip
}

export function macToString(mac: Uint8Array): string {
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(':')
}

/** "aa:bb:cc:dd:ee:ff" -> bytes, or null when malformed. */
export function macFromString(s: string): Uint8Array | null {
  const parts = s.trim().split(':')
  if (parts.length !== 6) return null
  const mac = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    if (!/^[0-9a-fA-F]{2}$/.test(parts[i])) return null
    mac[i] = parseInt(parts[i], 16)
  }
  return mac
}

export function macEquals(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false
  return true
}

export const MAC_BROADCAST = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** A DataView over exactly the bytes of `u8` (which may be a subarray). */
export function viewOf(u8: Uint8Array): DataView {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
}
