/**
 * Bitfield helpers for SVD-inspired register maps.
 *
 * CMSIS-SVD describes each field with an inclusive [lsb, msb] bit range; the
 * register-map UI and every chip's poke/setField path share these so a JSON
 * map and a TypeScript declaration decode the same way.
 */

import type { FieldDecl } from './types'

/** Inclusive bit-range width. */
export function fieldWidth(lsb: number, msb: number): number {
  return msb - lsb + 1
}

/** Mask covering [lsb, msb], already shifted into place. */
export function fieldMask(lsb: number, msb: number): number {
  return ((1 << fieldWidth(lsb, msb)) - 1) << lsb
}

/** Extract a field's value from a register word (unshifted). */
export function extractField(word: number, field: Pick<FieldDecl, 'lsb' | 'msb'>): number {
  return (word & fieldMask(field.lsb, field.msb)) >>> field.lsb
}

/** Read-modify-write a field into a register word. */
export function insertField(
  word: number,
  field: Pick<FieldDecl, 'lsb' | 'msb'>,
  value: number,
): number {
  const mask = fieldMask(field.lsb, field.msb)
  const width = fieldWidth(field.lsb, field.msb)
  const clipped = value & ((1 << width) - 1)
  return (word & ~mask) | ((clipped << field.lsb) & mask)
}

/** Hex dump of a register word at its declared width (e.g. `0x60A0`). */
export function formatRegHex(value: number, bytes: 1 | 2 | 3 | 4): string {
  const width = bytes * 2
  const masked =
    bytes === 1
      ? value & 0xff
      : bytes === 2
        ? value & 0xffff
        : bytes === 3
          ? value & 0xffffff
          : value >>> 0
  return `0x${masked.toString(16).toUpperCase().padStart(width, '0')}`
}

/** Compact bit-range label matching SVD style (`[7:4]` or `[3]`). */
export function formatBitRange(lsb: number, msb: number): string {
  return lsb === msb ? `[${lsb}]` : `[${msb}:${lsb}]`
}

/** Look up an enumerated name for a field value, if the map lists one. */
export function decodeFieldLabel(
  field: Pick<FieldDecl, 'values'>,
  value: number,
): string | undefined {
  return field.values?.find((entry) => entry.value === value)?.name
}
