/**
 * Pull a few high-signal fields out of QEMU's `info registers` dump.
 *
 * The dump is architecture-specific free text (HMP / `cpu_dump_state`), not a
 * stable API. We only need a PC for the pause chip and a short headline; the
 * raw dump stays available for anyone who opens the popover. Patterns cover
 * the three guests this page boots: Cortex-M (R15), AArch64 (PC=), RISC-V (pc).
 */

export interface ParsedRegisters {
  /** Program counter as QEMU printed it (hex digits, no 0x prefix normalised). */
  pc: string | null
  /** One-line summary for the closed chip, e.g. `PC 00001234`. */
  summary: string | null
}

const PC_PATTERNS: RegExp[] = [
  /\bPC=([0-9A-Fa-f]+)/, // aarch64 / some arm dumps
  /\bR15=([0-9A-Fa-f]+)/, // arm cortex-m / classic arm
  /^pc\s+([0-9A-Fa-f]+)/m, // riscv
]

export function parseRegisters(dump: string): ParsedRegisters {
  let pc: string | null = null
  for (const re of PC_PATTERNS) {
    const match = dump.match(re)
    if (match?.[1]) {
      pc = match[1].toLowerCase()
      break
    }
  }
  return {
    pc,
    summary: pc ? `PC ${pc}` : null,
  }
}
