/**
 * Arch-specific decoding of the gdbstub `g` register blob.
 *
 * Layouts match QEMU's gdbstub for the three guests this page boots. Values
 * are little-endian in the packet; we emit NAME=value lines so RegisterGrid /
 * organizeRegisters can lay them out.
 */

import { hexToBytes } from '@/debug/gdb/rspCodec'

export type GdbArch = 'arm' | 'aarch64' | 'riscv32' | 'xtensa'

/**
 * The four registers an unwinder cares about, as numbers.
 *
 * Kept separate from {@link RegView.dump} (which is display text) so the call
 * stack does not have to re-parse its own formatting.
 */
export interface FrameRegs {
  pc: number | null
  sp: number | null
  /** Frame pointer: x29 (aarch64), r7 (thumb), s0 (riscv). */
  fp: number | null
  /** Return address register: x30 / r14 / ra. */
  lr: number | null
}

export const NO_FRAME_REGS: FrameRegs = { pc: null, sp: null, fp: null, lr: null }

export interface RegView {
  pc: string | null
  /** NAME=value lines for the popover / organizeRegisters. */
  dump: string
  summary: string | null
  /** Numeric PC / SP / FP / LR for the call-stack unwinder. */
  frame: FrameRegs
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
    return { pc: null, dump: hex, summary: null, frame: NO_FRAME_REGS }
  }

  if (arch === 'arm') return decodeArm(bytes)
  if (arch === 'aarch64') return decodeAarch64(bytes)
  if (arch === 'xtensa') return decodeXtensa(bytes)
  return decodeRiscv32(bytes)
}

function decodeArm(bytes: Uint8Array): RegView {
  // r0..r12, sp, lr, pc, xpsr  (17 × 4)
  if (bytes.length < 17 * 4) {
    return { pc: null, dump: bytesToDump(bytes), summary: null, frame: NO_FRAME_REGS }
  }
  const names = [
    'R00', 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07',
    'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'XPSR',
  ]
  const lines = names.map((name, i) => `${name}=${hex32(u32(bytes, i * 4))}`)
  const pc = hex32(u32(bytes, 15 * 4))
  return {
    pc,
    dump: lines.join('\n'),
    summary: `PC ${pc}`,
    frame: {
      pc: u32(bytes, 15 * 4),
      sp: u32(bytes, 13 * 4),
      // Thumb code keeps its frame pointer in r7 (AAPCS uses r11 for ARM state,
      // but Cortex-M is Thumb-only).
      fp: u32(bytes, 7 * 4),
      lr: u32(bytes, 14 * 4),
    },
  }
}

function decodeAarch64(bytes: Uint8Array): RegView {
  // QEMU target/arm/gdbstub64.c:
  //   0..30  x0..x30   (8 bytes each)
  //   31     sp        (8)
  //   32     pc        (8)
  //   33     pstate    (4)  — not 8!
  // Core `g` packet is therefore 31*8 + 8 + 8 + 4 = 268 bytes.
  const spOff = 31 * 8
  const pcOff = 32 * 8
  const pstateOff = 33 * 8
  if (bytes.length < pcOff + 8) {
    return { pc: null, dump: bytesToDump(bytes), summary: null, frame: NO_FRAME_REGS }
  }
  const pc = hex64(u64(bytes, pcOff))
  const lines: string[] = [`PC=${pc}`, `SP=${hex64(u64(bytes, spOff))}`]
  lines.push(`X30=${hex64(u64(bytes, 30 * 8))}`)
  for (let i = 0; i < 30; i++) {
    lines.push(`X${i.toString().padStart(2, '0')}=${hex64(u64(bytes, i * 8))}`)
  }
  if (bytes.length >= pstateOff + 4) {
    lines.push(`PSTATE=${hex32(u32(bytes, pstateOff))}`)
  }
  return {
    pc,
    dump: lines.join('\n'),
    summary: `PC ${pc}`,
    frame: {
      pc: Number(u64(bytes, pcOff)),
      sp: Number(u64(bytes, spOff)),
      fp: Number(u64(bytes, 29 * 8)),
      lr: Number(u64(bytes, 30 * 8)),
    },
  }
}

function decodeRiscv32(bytes: Uint8Array): RegView {
  // 33 × 4: x0..x31, pc — pc is register 32
  if (bytes.length < 33 * 4) {
    return { pc: null, dump: bytesToDump(bytes), summary: null, frame: NO_FRAME_REGS }
  }
  const abi = [
    'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
    's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
    'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
    's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
  ]
  const pc = hex32(u32(bytes, 32 * 4))
  const lines = [`pc=${pc}`]
  for (let i = 1; i < 32; i++) {
    lines.push(`${abi[i]}=${hex32(u32(bytes, i * 4))}`)
  }
  return {
    pc,
    dump: lines.join('\n'),
    summary: `PC ${pc}`,
    frame: {
      pc: u32(bytes, 32 * 4),
      sp: u32(bytes, 2 * 4),
      fp: u32(bytes, 8 * 4), // s0
      lr: u32(bytes, 1 * 4), // ra
    },
  }
}

/**
 * How many physical address registers the ESP32 core has, and where its `g`
 * packet puts things. QEMU's Xtensa stub serves no target.xml, so the layout is
 * whatever target/xtensa/core-esp32/gdb-config.inc.c declares, minus the entry
 * types xtensa_count_regs() skips (window, mapped, unmapped, TIE state). That
 * comes to 157 registers and exactly 628 bytes, which is what the stub sends.
 *
 * The ESP32-S3 core has the same 64-entry register file and the same leading
 * layout, so both machines decode here.
 */
const XT_NAREG = 64
const XT_AR0 = 4
const XT_WINDOWBASE = 276
const XT_WINDOWSTART = 280
const XT_PS = 292
const XT_MIN_BYTES = XT_PS + 4

/**
 * Xtensa's windowed registers: a0..a15 are a rotating view of the physical
 * file, and the `g` packet carries the *physical* registers, so the ones the
 * ABI names have to be found through windowbase. That is the whole reason this
 * decoder needs more than a fixed offset table.
 */
function xtWindowReg(bytes: Uint8Array, windowbase: number, n: number): number {
  const phys = (windowbase * 4 + n) % XT_NAREG
  return u32(bytes, XT_AR0 + phys * 4)
}

function decodeXtensa(bytes: Uint8Array): RegView {
  if (bytes.length < XT_MIN_BYTES) {
    return { pc: null, dump: bytesToDump(bytes), summary: null, frame: NO_FRAME_REGS }
  }
  const pcValue = u32(bytes, 0)
  const pc = hex32(pcValue)
  const windowbase = u32(bytes, XT_WINDOWBASE) % (XT_NAREG / 4)

  // a1 is the stack pointer and a0 the return address, by the windowed ABI.
  const sp = xtWindowReg(bytes, windowbase, 1)
  const a0 = xtWindowReg(bytes, windowbase, 0)

  const lines = [`pc=${pc}`]
  for (let n = 0; n < 16; n++) {
    lines.push(`a${n.toString().padStart(2, '0')}=${hex32(xtWindowReg(bytes, windowbase, n))}`)
  }
  lines.push(`ps=${hex32(u32(bytes, XT_PS))}`)
  lines.push(`windowbase=${hex32(windowbase)}`)
  lines.push(`windowstart=${hex32(u32(bytes, XT_WINDOWSTART))}`)

  return {
    pc,
    dump: lines.join('\n'),
    summary: `PC ${pc}`,
    frame: {
      pc: pcValue,
      sp,
      // No frame-pointer chain to walk: the windowed ABI spills a caller's
      // registers below its own stack pointer rather than threading a record
      // through a fixed register, so the unwinder's `{caller fp, return}`
      // walk has nothing to follow. Leaving this null is what sends it to the
      // stack scan, which does work here, because the spill area is full of a0
      // values, and those are return addresses.
      fp: null,
      lr: xtReturnAddr(a0, pcValue),
    },
  }
}

/**
 * A windowed return address is not an address. `call4`/`call8`/`call12` put the
 * window increment in the top two bits of a0 and drop the top two bits of the
 * address, which the return reconstructs from the current PC, since code and its
 * callers always share a 1 GB region. Undo that so the value resolves against
 * the symbol table.
 */
function xtReturnAddr(a0: number, pc: number): number {
  return ((a0 & 0x3fff_ffff) | (pc & 0xc000_0000)) >>> 0
}

/** Map board.arch strings onto a gdb register layout. */
export function archFromBoard(arch: string): GdbArch {
  const a = arch.toLowerCase()
  // boards.ts uses "ARMv8-A" for Cortex-A53 — not the string "aarch64".
  if (
    a.includes('aarch64') ||
    a.includes('arm64') ||
    a.includes('armv8') ||
    a.includes('cortex-a')
  ) {
    return 'aarch64'
  }
  // boards.ts uses "RV32IMAFDC" for qemu_riscv32.
  if (a.includes('riscv') || a.startsWith('rv32') || a.startsWith('rv64')) return 'riscv32'
  // boards.ts uses "Xtensa LX6" for esp32_devkitc.
  if (a.includes('xtensa') || a.startsWith('lx6') || a.startsWith('lx7')) return 'xtensa'
  return 'arm'
}

/**
 * e_machine → gdb register layout, for a symbol ELF the page did not boot
 * (Live board sessions have no board picker to ask). Null when the machine
 * is one this page has no decoder for; the caller falls back to a manual
 * picker.
 */
export function archFromElf(bytes: Uint8Array): GdbArch | null {
  if (
    bytes.length < 0x14 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    return null
  }
  const little = bytes[5] === 1
  const machine = little
    ? bytes[0x12]! | (bytes[0x13]! << 8)
    : (bytes[0x12]! << 8) | bytes[0x13]!
  if (machine === 40) return 'arm' // EM_ARM
  if (machine === 183) return 'aarch64' // EM_AARCH64
  if (machine === 94) return 'xtensa' // EM_XTENSA
  // EM_RISCV: only the 32-bit layout is wired into decodeGPacket.
  if (machine === 243) return bytes[4] === 1 ? 'riscv32' : null
  return null
}

/** Software breakpoint kind (bytes) for Z0. */
export function breakpointKind(arch: GdbArch): number {
  if (arch === 'aarch64') return 4
  return 2
}

/** Stack-slot width — how far the unwinder steps between saved words. */
export function ptrBytes(arch: GdbArch): 4 | 8 {
  return arch === 'aarch64' ? 8 : 4
}

/**
 * Drop the Thumb bit so a code address matches symtab.
 * Return addresses on Cortex-M always carry it; symbol values do not.
 */
export function codeAddr(arch: GdbArch, addr: number): number {
  if (arch === 'arm') return (addr & ~1) >>> 0
  return addr
}

/**
 * Instruction sizes a call can have, for "did that step enter a call?".
 * A4-byte `bl` on AArch64/ARM; RISC-V adds the 2-byte compressed forms.
 * Every Xtensa call (`call0`/`call4`/`call8`/`call12` and the indirect
 * `callx` forms alike) is 3 bytes; the 2-byte density encodings hold no call.
 */
export function callInsnSizes(arch: GdbArch): number[] {
  if (arch === 'aarch64') return [4]
  if (arch === 'xtensa') return [3]
  return [4, 2]
}
