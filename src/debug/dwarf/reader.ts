/**
 * A cursor over one DWARF section.
 *
 * Offsets and addresses are JS numbers: every guest this page boots keeps its
 * code and data far below 2^53, and the line-table reader made the same call.
 * Values that may use all 64 bits (a `long long` constant, an expression stack
 * entry) come out of the `*Big` readers instead.
 */

export class DwarfReader {
  constructor(
    readonly data: Uint8Array,
    public at = 0,
    readonly little = true,
  ) {}

  get done(): boolean {
    return this.at >= this.data.length
  }

  u8(): number {
    return this.data[this.at++] ?? 0
  }

  i8(): number {
    return (this.u8() << 24) >> 24
  }

  u16(): number {
    const a = this.u8()
    const b = this.u8()
    return this.little ? a | (b << 8) : (a << 8) | b
  }

  i16(): number {
    return (this.u16() << 16) >> 16
  }

  u24(): number {
    const a = this.u8()
    const b = this.u8()
    const c = this.u8()
    return this.little ? a | (b << 8) | (c << 16) : (a << 16) | (b << 8) | c
  }

  u32(): number {
    const a = this.u16()
    const b = this.u16()
    return (this.little ? a + b * 0x1_0000 : a * 0x1_0000 + b) >>> 0
  }

  i32(): number {
    return this.u32() | 0
  }

  u64(): number {
    const a = this.u32()
    const b = this.u32()
    return this.little ? a + b * 0x1_0000_0000 : a * 0x1_0000_0000 + b
  }

  u64Big(): bigint {
    const a = BigInt(this.u32())
    const b = BigInt(this.u32())
    return this.little ? (b << 32n) | a : (a << 32n) | b
  }

  /** An unsigned value of `size` bytes (1, 2, 4 or 8). */
  uSized(size: number): number {
    if (size === 1) return this.u8()
    if (size === 2) return this.u16()
    if (size === 4) return this.u32()
    return this.u64()
  }

  uSizedBig(size: number): bigint {
    if (size === 8) return this.u64Big()
    return BigInt(this.uSized(size))
  }

  /** A target address of `size` bytes. */
  addr(size: number): number {
    return size === 8 ? this.u64() : this.u32()
  }

  /** A section offset: 4 bytes in 32-bit DWARF, 8 in 64-bit DWARF. */
  offset(size: 4 | 8): number {
    return size === 8 ? this.u64() : this.u32()
  }

  uleb(): number {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = this.u8()
      value += (byte & 0x7f) * scale
      if ((byte & 0x80) === 0 || this.at >= this.data.length) return value
      scale *= 128
      if (scale > 2 ** 63) return value
    }
  }

  sleb(): number {
    let value = 0
    let scale = 1
    let byte = 0
    do {
      byte = this.u8()
      value += (byte & 0x7f) * scale
      scale *= 128
    } while (byte & 0x80 && this.at < this.data.length && scale <= 2 ** 63)
    if (byte & 0x40) value -= scale
    return value
  }

  ulebBig(): bigint {
    let value = 0n
    let shift = 0n
    for (;;) {
      const byte = this.u8()
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n
      if ((byte & 0x80) === 0 || this.at >= this.data.length || shift > 70n) return value
    }
  }

  slebBig(): bigint {
    let value = 0n
    let shift = 0n
    let byte = 0
    do {
      byte = this.u8()
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n
    } while (byte & 0x80 && this.at < this.data.length && shift <= 70n)
    if (byte & 0x40) value -= 1n << shift
    return value
  }

  cstring(): string {
    const start = this.at
    while (this.at < this.data.length && this.data[this.at] !== 0) this.at++
    const text = decoder.decode(this.data.subarray(start, this.at))
    this.at++
    return text
  }

  bytes(n: number): Uint8Array {
    const out = this.data.subarray(this.at, this.at + n)
    this.at += n
    return out
  }

  skip(n: number): void {
    this.at += n
  }
}

const decoder = new TextDecoder()

/** The NUL-terminated string at `offset` in a string section. */
export function stringAt(section: Uint8Array | null, offset: number): string {
  if (!section || offset < 0 || offset >= section.length) return ''
  let end = offset
  while (end < section.length && section[end] !== 0) end++
  return decoder.decode(section.subarray(offset, end))
}
