/**
 * Find the pointers in a memory window.
 *
 * Nothing here can *know* a word is a pointer — memory is untyped, and a
 * counter can hold a value that happens to name something. Three filters keep
 * the guesses honest, in order of how much they buy:
 *
 * 1. The value has to land on something the image actually names — a live
 *    object core object, a thread stack, a data symbol, a function. Named
 *    ranges are a tiny fraction of the address space, so arbitrary data
 *    almost never hits one. (This is why unnamed-but-in-RAM values are left
 *    alone: half a stack frame would light up and mean nothing.)
 * 2. The word has to be pointer-aligned, at its absolute address.
 * 3. Small integers are not addresses. Counts, sizes, priorities and flags are
 *    the overwhelming majority of non-pointer words, and on a Cortex-M — where
 *    text starts at 0 — they are also the only ones that can collide with a
 *    real symbol. The cost is a missed pointer to code in the first 4 KiB,
 *    which in practice is startup code nothing holds a pointer to.
 *
 * What survives is a resolution, not a claim: the dump still shows the bytes,
 * the tooltip leads with the raw value, and clicking a byte still edits it.
 */

import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'

export interface PointerRun {
  /** Absolute guest address of the word. */
  addr: number
  /** Byte offset into the window. */
  offset: number
  /** Bytes the word occupies — 4 or 8. */
  length: number
  /** The value stored there. */
  value: number
  /** What that value points at. */
  target: ResolvedAddress
  /**
   * The word holds its own address: an empty `sys_dlist_t` head/tail. Kept as a
   * run so it still reads as "this is a pointer", but not offered as a link —
   * following it goes nowhere, and seeing it flagged is how you spot an empty
   * wait queue at a glance.
   */
  self: boolean
}

/** Below this a word is treated as a number, not an address. See the note above. */
export const MIN_POINTER = 0x1000

function readLe(bytes: Uint8Array, at: number, length: number): number {
  let value = 0
  for (let i = length - 1; i >= 0; i--) value = value * 256 + bytes[at + i]!
  return value
}

/** Pointer width for the guest ABI. */
export function pointerBytes(arch: 'arm' | 'aarch64' | 'riscv32' | null): 4 | 8 {
  return arch === 'aarch64' ? 8 : 4
}

export function decodeWindowPointers({
  base,
  bytes,
  ptrBytes,
  map,
}: {
  base: number
  bytes: Uint8Array
  ptrBytes: 4 | 8
  map: AddressMap | null
}): PointerRun[] {
  if (!map || bytes.length < ptrBytes) return []
  const out: PointerRun[] = []
  // Align on the absolute address, not the window offset — the address bar
  // takes any address, so the window is not always pointer-aligned.
  const first = (ptrBytes - (base % ptrBytes)) % ptrBytes
  for (let offset = first; offset + ptrBytes <= bytes.length; offset += ptrBytes) {
    const value = readLe(bytes, offset, ptrBytes)
    if (value < MIN_POINTER || !Number.isSafeInteger(value)) continue
    const target = map.resolve(value)
    if (!target) continue
    const addr = base + offset
    out.push({ addr, offset, length: ptrBytes, value, target, self: value === addr })
  }
  return out
}

/** Lookup from any byte offset in the window to the run covering it. */
export function pointerRunsByOffset(runs: readonly PointerRun[]): Map<number, PointerRun> {
  const out = new Map<number, PointerRun>()
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) out.set(run.offset + i, run)
  }
  return out
}
