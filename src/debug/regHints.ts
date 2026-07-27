/**
 * Register hover hints: ABI roles + DWARF formal parameter names when known.
 *
 * Host-only. Works from register names in the dump (no guest changes). DWARF
 * formals are optional — without them we still label arg/return/temp/callee-saved.
 */

export type HintArch = 'arm' | 'aarch64' | 'riscv32'

export interface RegHintContext {
  arch: HintArch | null
  /** Function containing PC (from symtab / pcLabel). */
  functionName: string | null
  /** Formal parameter names in declaration order (DWARF), if available. */
  formals: string[]
}

/** Infer arch from register names in a dump. */
export function inferArchFromDump(dump: string): HintArch | null {
  if (/\bX\d{2}=/i.test(dump) || /\bPSTATE=/i.test(dump)) return 'aarch64'
  if (/\bR\d{2}=/i.test(dump) || /\bXPSR=/i.test(dump)) return 'arm'
  if (/\ba0=/i.test(dump) || /\bra=/i.test(dump)) return 'riscv32'
  return null
}

export function functionNameFromLabel(label: string | null | undefined): string | null {
  if (!label) return null
  const plus = label.indexOf('+')
  const name = (plus >= 0 ? label.slice(0, plus) : label).trim()
  return name || null
}

function formalAt(formals: string[], index: number): string | null {
  const n = formals[index]
  return n && n.length > 0 ? n : null
}

function argHint(index: number, formals: string[], alsoReturn = false): string {
  const name = formalAt(formals, index)
  const ordinal = `arg${index}`
  if (name && alsoReturn) return `${name} · ${ordinal} / return`
  if (name) return `${name} · ${ordinal}`
  if (alsoReturn) return `${ordinal} / return value`
  return ordinal
}

/** Short ABI + DWARF role for a register name (e.g. X00, R01, a0). */
export function regRole(name: string, ctx: RegHintContext): string | null {
  const n = name.toUpperCase()
  const formals = ctx.formals
  const arch = ctx.arch ?? inferArchFromName(n)

  if (n === 'PC') return 'program counter'
  if (n === 'SP' || n === 'R13') return 'stack pointer'
  if (n === 'LR' || n === 'R14' || n === 'X30' || n === 'RA') return 'link register (return addr)'
  if (n === 'PSTATE' || n === 'XPSR' || n === 'CPSR' || n === 'SPSR') return 'status / flags'
  if (n === 'FP' || n === 'X29' || n === 'S0' || n === 'R11') {
    if (arch === 'aarch64' && n === 'X29') return 'frame pointer'
    if (arch === 'arm' && n === 'R11') return 'frame pointer (typical)'
    if (arch === 'riscv32' && n === 'S0') return 'frame pointer / s0'
  }

  if (arch === 'aarch64') {
    const m = /^X(\d{2})$/.exec(n)
    if (m) {
      const i = Number(m[1])
      if (i <= 7) return argHint(i, formals, i === 0)
      if (i === 8) return 'indirect result / syscall #'
      if (i <= 15) return 'caller-saved temp'
      if (i <= 17) return i === 16 ? 'IP0 (linker veneer)' : 'IP1 (linker veneer)'
      if (i === 18) return 'platform register'
      if (i <= 28) return 'callee-saved'
    }
  }

  if (arch === 'arm') {
    const m = /^R(\d{2})$/.exec(n)
    if (m) {
      const i = Number(m[1])
      if (i <= 3) return argHint(i, formals, i === 0)
      if (i === 12) return 'intra-procedure scratch (IP)'
      if (i >= 4 && i <= 11) return 'callee-saved'
    }
  }

  if (arch === 'riscv32') {
    const low = name.toLowerCase()
    const argRegs = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
    const ai = argRegs.indexOf(low)
    if (ai >= 0) return argHint(ai, formals, ai === 0)
    if (low === 'gp') return 'global pointer'
    if (low === 'tp') return 'thread pointer'
    if (low.startsWith('s')) return 'callee-saved'
    if (low.startsWith('t')) return 'caller-saved temp'
    if (low === 'zero') return 'hard-wired zero'
  }

  return null
}

function inferArchFromName(n: string): HintArch | null {
  if (/^X\d{2}$/.test(n) || n === 'PSTATE') return 'aarch64'
  if (/^R\d{2}$/.test(n) || n === 'XPSR') return 'arm'
  return null
}

/**
 * Native `title` tooltip text for a register cell.
 * Includes value, role, and current function when relevant.
 */
export function regTooltip(
  name: string,
  valueHex: string,
  ctx: RegHintContext,
  opts?: { canPeek?: boolean },
): string {
  const lines: string[] = [`0x${valueHex}`]
  const role = regRole(name, ctx)
  if (role) lines.push(role)
  if (ctx.functionName && role && /arg\d|return/.test(role)) {
    lines.push(`in ${ctx.functionName}`)
  } else if (ctx.functionName && (name === 'PC' || name === 'LR' || name === 'X30' || name === 'RA')) {
    lines.push(`in ${ctx.functionName}`)
  }
  if (opts?.canPeek) lines.push('Click to peek memory')
  return lines.join('\n')
}
