/** Shared helpers for Zephyr sys-* data-structure peeks over RSP memory. */

export type PtrWidth = 4 | 8

export type MemoryReader = (addr: number, length: number) => Promise<Uint8Array | null>

export function ptrWidthForArch(arch: 'arm' | 'aarch64' | 'riscv32' | null): PtrWidth {
  return arch === 'aarch64' ? 8 : 4
}

export function alignDown(addr: number, width: PtrWidth): number {
  return (addr >>> 0) & ~(width - 1)
}

export function looksLikePtr(value: number, width: PtrWidth): boolean {
  if (value === 0) return true
  if (value & (width - 1)) return false
  // Reject tiny / obviously non-RAM values. Guest RAM on our boards sits well above this.
  if (value < 0x1000) return false
  return true
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0
}

export function readU64Lo(bytes: Uint8Array, offset: number): number {
  // Guest pointers on AArch64 Zephyr samples stay in the low 4 GB for our images.
  return readU32(bytes, offset)
}

export function readPtr(bytes: Uint8Array, offset: number, width: PtrWidth): number {
  return width === 8 ? readU64Lo(bytes, offset) : readU32(bytes, offset)
}

export async function readBytes(
  read: MemoryReader,
  addr: number,
  length: number,
): Promise<Uint8Array | null> {
  if (length <= 0) return new Uint8Array(0)
  return read(addr >>> 0, length)
}

export function fmtAddr(addr: number): string {
  return (addr >>> 0).toString(16)
}

export const MAX_WALK_NODES = 64
