/**
 * `at:` — turning a place in the source into an address to break on.
 *
 * Five spellings, in the order a reader would try them:
 *
 *     at: main.c:/toggle_dt/     the first line matching a pattern
 *     at: main.c:31              a line, resolved through DWARF
 *     at: gpio_pin_configure     a function, past its prologue
 *     at: main+0x1c              a function, at an offset
 *     at: 0x40001234             an address, for when nothing else will do
 *
 * The pattern form is the one to reach for. A tour is written against upstream
 * sources that keep moving — the samples here track Zephyr `main` — and a line
 * number is a fact about a moment in someone else's git history. `/toggle_dt/`
 * still means what it meant. CodeTour learnt the same lesson and grew the same
 * feature.
 *
 * It has one weakness the others do not: searching source text needs the source
 * text, which arrives with the guest images rather than with the page, and an
 * older image tarball does not carry it. So `at:` takes alternatives, tried in
 * order and separated by `|`:
 *
 *     at: main.c:/gpio_pin_toggle_dt/ | main.c:38
 *
 * The pattern when the sources are there, the line number when they are not.
 * Each covers the other's failure: the line drifts with upstream, the pattern
 * depends on an artifact somebody else built.
 *
 * All four are looked up in the ELF the page already fetched to boot the guest,
 * which is why a tour can point at code it does not own: `at: z_impl_k_sleep`
 * breaks inside the kernel, and the sample it is teaching never knows.
 */

import {
  addressForLine,
  bodyStart,
  locationForAddress,
  type LineIndex,
} from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import { codeAddr, type GdbArch } from '@/debug/gdb/regs'

export interface AnchorContext {
  symbols: SymbolIndex | null
  lines: LineIndex | null
  arch: GdbArch | null
  /** Shipped sources by basename, split into lines — for pattern anchors. */
  sources?: Map<string, string[]>
}

export interface ResolvedAnchor {
  addr: number
  /** Which spelling matched, so the card can say how it got there. */
  via: 'line' | 'pattern' | 'symbol' | 'address'
  /** Source location, when the line table knows one. */
  file: string | null
  line: number | null
  /** Enclosing function, when symbols know one. */
  symbol: string | null
}

export type AnchorResult = { ok: true; anchor: ResolvedAnchor } | { ok: false; error: string }

/**
 * Drop the Thumb bit — {@link codeAddr}, tolerating an arch we do not know yet.
 *
 * On Cortex-M every function symbol has bit 0 set to mark the instruction set,
 * and it is not part of the address: planting a breakpoint at an odd address
 * would place it one byte into the first instruction. Run control already has
 * the rule, so it is borrowed rather than restated.
 */
export function normalizeAddr(addr: number, arch: GdbArch | null): number {
  // Unknown arch: leave it alone rather than guess — and never truncate,
  // since an AArch64 address does not fit in the 32 bits `>>> 0` would keep.
  return arch ? codeAddr(arch, addr) : addr
}

const ADDRESS = /^0x[0-9a-f]+$/i
const FILE_PATTERN = /^(\S+\.[A-Za-z]\w*):\/(.+)\/$/
const FILE_LINE = /^(\S+\.[A-Za-z]\w*):(\d+)$/
const SYMBOL_OFFSET = /^([A-Za-z_]\w*)\s*\+\s*(0x[0-9a-f]+|\d+)$/i
const SYMBOL = /^[A-Za-z_]\w*$/

/**
 * Resolve an `at:`, trying each `|`-separated alternative in turn.
 *
 * The first that resolves wins. If none do, the reader gets every reason rather
 * than only the last, since "no line matches" and "no such function" point at
 * quite different mistakes.
 */
export function resolveAnchor(at: string, ctx: AnchorContext): AnchorResult {
  const alternatives = at.split('|').map((part) => part.trim()).filter((part) => part !== '')
  if (alternatives.length === 0) return { ok: false, error: '`at:` is empty' }

  const errors: string[] = []
  for (const alternative of alternatives) {
    const result = resolveOne(alternative, ctx)
    if (result.ok) return result
    errors.push(result.error)
  }
  return { ok: false, error: errors.join('; ') }
}

function resolveOne(at: string, ctx: AnchorContext): AnchorResult {
  const raw = at.trim()

  if (ADDRESS.test(raw)) {
    const addr = Number(raw)
    return { ok: true, anchor: { addr, via: 'address', ...describe(addr, ctx) } }
  }

  const pattern = FILE_PATTERN.exec(raw)
  if (pattern) {
    const file = pattern[1]!
    const source = findSource(ctx, file)
    if (!source) {
      return { ok: false, error: `\`${raw}\`: \`${file}\` was not shipped, so its text cannot be searched` }
    }
    let re: RegExp
    try {
      re = new RegExp(pattern[2]!)
    } catch {
      return { ok: false, error: `\`${raw}\`: not a valid pattern` }
    }
    const hit = source.findIndex((text) => re.test(text))
    if (hit < 0) return { ok: false, error: `\`${raw}\`: no line matches` }
    if (!ctx.lines) {
      return { ok: false, error: `\`${raw}\`: this build carries no DWARF line table` }
    }
    const match = addressForLine(ctx.lines, file, hit + 1)
    if (!match) return { ok: false, error: `\`${raw}\`: no code at or after the matching line` }
    return {
      ok: true,
      anchor: {
        addr: normalizeAddr(match.addr, ctx.arch),
        via: 'pattern',
        file: match.file,
        line: match.line,
        symbol: describe(match.addr, ctx).symbol,
      },
    }
  }

  const fileLine = FILE_LINE.exec(raw)
  if (fileLine) {
    if (!ctx.lines) {
      return { ok: false, error: `\`${raw}\`: this build carries no DWARF line table` }
    }
    const match = addressForLine(ctx.lines, fileLine[1]!, Number(fileLine[2]))
    if (!match) {
      return { ok: false, error: `\`${raw}\`: no code at or after that line` }
    }
    return {
      ok: true,
      anchor: {
        addr: normalizeAddr(match.addr, ctx.arch),
        via: 'line',
        file: match.file,
        line: match.line,
        symbol: describe(match.addr, ctx).symbol,
      },
    }
  }

  const withOffset = SYMBOL_OFFSET.exec(raw)
  const name = withOffset ? withOffset[1]! : SYMBOL.test(raw) ? raw : null
  if (name === null) return { ok: false, error: `\`${raw}\` is not a line, a symbol or an address` }

  const symbol = ctx.symbols?.byName.find((s) => s.name === name)
  if (!symbol) return { ok: false, error: `\`${name}\`: no such function in this build` }

  const base = normalizeAddr(symbol.addr, ctx.arch)
  if (withOffset) {
    const addr = base + Number(withOffset[2])
    return { ok: true, anchor: { addr, via: 'symbol', ...describe(addr, ctx), symbol: name } }
  }

  // Bare function name: past the prologue, where gdb's `break func` lands and
  // where the arguments have reached the places DWARF says they live.
  const entry =
    ctx.lines && symbol.size > 0 ? bodyStart(ctx.lines, base, base + symbol.size) : null
  const addr = entry !== null ? normalizeAddr(entry, ctx.arch) : base
  return { ok: true, anchor: { addr, via: 'symbol', ...describe(addr, ctx), symbol: name } }
}

/** Source location and enclosing function for an address, best effort. */
function describe(addr: number, ctx: AnchorContext): Pick<ResolvedAnchor, 'file' | 'line' | 'symbol'> {
  const location = ctx.lines ? locationForAddress(ctx.lines, addr) : null
  const symbol = ctx.symbols?.byAddr.find(
    (s) => addr >= normalizeAddr(s.addr, ctx.arch) && addr < normalizeAddr(s.addr, ctx.arch) + Math.max(s.size, 1),
  )
  return {
    file: location?.file ?? null,
    line: location?.line ?? null,
    symbol: symbol?.name ?? null,
  }
}

/** The shipped copy of a source file, by basename or path suffix. */
function findSource(ctx: AnchorContext, file: string): string[] | null {
  const want = file.toLowerCase()
  const direct = ctx.sources?.get(want)
  if (direct) return direct
  for (const [name, lines] of ctx.sources ?? []) {
    if (name.endsWith(`/${want}`)) return lines
  }
  return null
}

/**
 * The file a tour needs the text of, so the store knows what to fetch. Checks
 * every alternative, since the pattern may not be the first one written.
 */
export function patternFile(at: string): string | null {
  for (const alternative of at.split('|')) {
    const match = FILE_PATTERN.exec(alternative.trim())
    if (match) return match[1]!.toLowerCase()
  }
  return null
}
