/**
 * Turn a free-text register dump into a layout the popover can render.
 *
 * Accepts QEMU HMP `info registers` and our gdb `g`-decoded NAME=value lines.
 * Classification is best-effort by name — unknown tokens fall into General.
 */

export interface RegEntry {
  name: string
  value: string
}

export interface RegisterLayout {
  pc: string | null
  summary: string | null
  /** PC / SP / LR (or arch aliases) — shown large above the grid. */
  featured: RegEntry[]
  /** General-purpose regs in dump order. */
  general: RegEntry[]
  /** Status / PSR / flags. */
  status: RegEntry[]
}

const PAIR_EQ = /\b([A-Za-z][A-Za-z0-9_.]*)\s*=\s*([0-9A-Fa-f]+)\b/g
const PAIR_WS = /^([a-z][a-z0-9_]*)\s+([0-9A-Fa-f]+)\s*$/gim

function roleOf(name: string): 'pc' | 'sp' | 'lr' | 'status' | 'general' {
  const n = name.toLowerCase()
  if (n === 'pc' || n === 'r15' || n === 'rip' || n === 'eip') return 'pc'
  if (n === 'sp' || n === 'r13' || n === 'xsp' || n === 'ssp') return 'sp'
  if (n === 'lr' || n === 'r14' || n === 'ra' || n === 'x30') return 'lr'
  if (
    n === 'xpsr' ||
    n === 'cpsr' ||
    n === 'spsr' ||
    n === 'psr' ||
    n === 'pstate' ||
    n === 'mstatus' ||
    n === 'sstatus' ||
    n.endsWith('psr')
  ) {
    return 'status'
  }
  return 'general'
}

function displayName(name: string, role: ReturnType<typeof roleOf>): string {
  if (role === 'pc') return 'PC'
  if (role === 'sp') return 'SP'
  if (role === 'lr') return name.toLowerCase() === 'ra' ? 'RA' : 'LR'
  return name.toUpperCase()
}

/** Parse NAME=value and "name  value" pairs into a structured layout. */
export function organizeRegisters(dump: string | null | undefined): RegisterLayout {
  const empty: RegisterLayout = {
    pc: null,
    summary: null,
    featured: [],
    general: [],
    status: [],
  }
  if (!dump?.trim()) return empty

  const seen = new Set<string>()
  const entries: RegEntry[] = []

  for (const match of dump.matchAll(PAIR_EQ)) {
    const rawName = match[1]!
    const value = match[2]!.toLowerCase()
    const key = rawName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ name: rawName, value })
  }
  for (const match of dump.matchAll(PAIR_WS)) {
    const rawName = match[1]!
    const value = match[2]!.toLowerCase()
    const key = rawName.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ name: rawName, value })
  }

  if (entries.length === 0) return empty

  const featured: RegEntry[] = []
  const general: RegEntry[] = []
  const status: RegEntry[] = []
  let pc: string | null = null

  // Prefer a stable featured order: PC, SP, LR.
  const byRole: Partial<Record<'pc' | 'sp' | 'lr', RegEntry>> = {}
  for (const entry of entries) {
    const role = roleOf(entry.name)
    const named = { name: displayName(entry.name, role), value: entry.value }
    if (role === 'pc' || role === 'sp' || role === 'lr') {
      if (!byRole[role]) byRole[role] = named
      if (role === 'pc') pc = entry.value
    } else if (role === 'status') {
      status.push(named)
    } else {
      general.push({ name: displayName(entry.name, 'general'), value: entry.value })
    }
  }
  for (const role of ['pc', 'sp', 'lr'] as const) {
    if (byRole[role]) featured.push(byRole[role]!)
  }

  return {
    pc,
    summary: pc ? `PC ${pc}` : null,
    featured,
    general,
    status,
  }
}
