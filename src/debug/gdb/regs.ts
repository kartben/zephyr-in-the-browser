/**
 * Arch-specific decoding of the gdbstub `g` register blob.
 *
 * Layouts match QEMU's gdbstub for the three guests this page boots. Values
 * are little-endian in the packet; we surface hex strings without a 0x prefix.
 */

import { hexToBytes } from '@/debug/gdb/rspCodec'

export type GdbArch = 'arm' | 'aarch64' | 'riscv32'

export interface RegView {
  pc: string | null
  /** Multi-line dump for the popover. */
  dump: string
  summary: string | null
}

function u32(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] ?? 0) |
      ((bytes[off + 1] ?? 0) << 8) |
      ((bytes[off + 2] ?? 0) << 16) |
      ((bytes[off + 3] ?? 0) << 24)) >>>
    0
  )
}

function u64(bytes: Uint8Array, off: number): bigint {
  const lo = BigInt(u32(bytes, off))
  const hi = BigInt(u32(bytes, off + 4))
  return (hi << 32n) | lo
}

function hex32(n: number): string {
  return n.toString(16).padStart(8, '0')
}

function hex64(n: bigint): string {
  return n.toString(16).padStart(16, '0')
}

function bytesToDump(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

/** Decode a `g` reply for the given architecture. */
export function decodeGPacket(arch: GdbArch, hex: string): RegView {
  let bytes: Uint8Array
  try {
    bytes = hexToBytes(hex)
  } catch {
    return { pc: null, dump: hex, summary: null }
  }

  if (arch === 'arm') return decodeArm(bytes)
  if (arch === 'aarch64') return decodeAarch64(bytes)
  return decodeRiscv32(bytes)
}

function decodeArm(bytes: Uint8Array): RegView {
  // r0..r12, sp, lr, pc, xpsr  (17 × 4)
  if (bytes.length < 17 * 4) {
    return { pc: null, dump: bytesToDump(bytes), summary: null }
  }
  const names = [
    'R00', 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07',
    'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'XPSR',
  ]
  const vals = names.map((name, i) => `${name}=${hex32(u32(bytes, i * 4))}`)
  const pc = hex32(u32(bytes, 15 * 4))
  const lines: string[] = []
  for (let i = 0; i < vals.length; i += 4) lines.push(vals.slice(i, i + 4).join(' '))
  return { pc, dump: lines.join('\n'), summary: `PC ${pc}` }
}

function decodeAarch64(bytes: Uint8Array): RegView {
  // x0..x30, sp, pc — each 8 bytes; pc at index 33
  const pcOff = 33 * 8
  if (bytes.length < pcOff + 8) {
    return { pc: null, dump: bytesToDump(bytes), summary: null }
  }
  const pc = hex64(u64(bytes, pcOff))
  const lines: string[] = [`PC=${pc}`]
  for (let i = 0; i < 8; i++) {
    lines.push(`X${i.toString().padStart(2, '0')}=${hex64(u64(bytes, i * 8))}`)
  }
  return { pc, dump: lines.join('\n'), summary: `PC ${pc}` }
}

function decodeRiscv32(bytes: Uint8Array): RegView {
  // 33 × 4: x0..x31, pc — pc is register 32
  if (bytes.length < 33 * 4) {
    return { pc: null, dump: bytesToDump(bytes), summary: null }
  }
  const pc = hex32(u32(bytes, 32 * 4))
  const lines = [`pc       ${pc}`]
  for (const [name, idx] of [
    ['ra', 1],
    ['sp', 2],
    ['gp', 3],
    ['tp', 4],
  ] as const) {
    lines.push(`${name}       ${hex32(u32(bytes, idx * 4))}`)
  }
  return { pc, dump: lines.join('\n'), summary: `PC ${pc}` }
}

/** Map board.arch strings onto a gdb register layout. */
export function archFromBoard(arch: string): GdbArch {
  const a = arch.toLowerCase()
  if (a.includes('aarch64') || a.includes('arm64')) return 'aarch64'
  if (a.includes('riscv')) return 'riscv32'
  return 'arm'
}

/** Software breakpoint kind (bytes) for Z0. */
export function breakpointKind(arch: GdbArch): number {
  if (arch === 'aarch64') return 4
  return 2
}
