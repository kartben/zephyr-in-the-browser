/**
 * The variables a stopped guest can show, from the DWARF in its own ELF.
 *
 * One engine per image, built on first use and kept with the image's bytes.
 * It answers three questions:
 *
 * - **Where are we?** {@link DwarfEngine.framesAt}: the function the PC is in,
 *   split into one frame per inlined call, innermost first. At -O2 the line
 *   the guest is stopped on is often inside an inlined helper, and its caller's
 *   variables are a frame further out, not in the same scope.
 * - **What does a name mean there?** {@link DwarfEngine.resolve} finds it the
 *   way C does: the innermost block first, then the function, then the file,
 *   then the whole program.
 * - **Where does it live?** {@link DwarfEngine.locate} runs the variable's
 *   location expression for this PC, with the frame base from `.debug_frame`.
 */

import { AT, TAG } from '@/debug/dwarf/constants'
import { CallFrameInfo } from '@/debug/dwarf/cfi'
import type { AttrValue, Die, Unit } from '@/debug/dwarf/info'
import { DwarfInfo } from '@/debug/dwarf/info'
import { evaluateLocation, OPTIMIZED_OUT, type ExprContext, type Location } from '@/debug/dwarf/locexpr'
import { locationAt } from '@/debug/dwarf/loclists'
import { containsPc, dieRanges } from '@/debug/dwarf/ranges'
import { TypeTable } from '@/debug/dwarf/types'

/** What the engine needs from a stopped machine. */
export interface FrameTarget {
  pc: number
  /** A register by DWARF number, or null when it cannot be read. */
  reg(n: number): bigint | null
  read(addr: number, size: number): Promise<Uint8Array | null>
}

/** One function activation at the PC: a real function, or an inlined call. */
export interface Frame {
  /** `DW_TAG_subprogram` or `DW_TAG_inlined_subroutine` (concrete). */
  fn: Die
  /** The frame's scopes that contain the PC, `fn` first, innermost last. */
  scopes: Die[]
  /** The real function around it, whose frame base the locals use. */
  subprogram: Die
  name: string
  inlined: boolean
}

export type VarKind = 'param' | 'local' | 'static' | 'global'

export interface Variable {
  name: string
  /** The concrete DIE, or the abstract one when no code was kept for it. */
  die: Die
  kind: VarKind
  /** The frame it belongs to; null for a file static or a global. */
  frame: Frame | null
}

const SCOPE_TAGS = new Set<number>([TAG.subprogram, TAG.inlined_subroutine, TAG.lexical_block])
const FRAME_TAGS = new Set<number>([TAG.subprogram, TAG.inlined_subroutine])

const engines = new WeakMap<Uint8Array, DwarfEngine | null>()

export class DwarfEngine {
  readonly types: TypeTable
  private cfiCache: CallFrameInfo | null | undefined

  private constructor(
    readonly elf: Uint8Array,
    readonly info: DwarfInfo,
  ) {
    this.types = new TypeTable(info, elf[4] === 2 ? 8 : 4)
  }

  /** The engine for an image, or null when it carries no DWARF. */
  static forElf(elf: Uint8Array): DwarfEngine | null {
    if (engines.has(elf)) return engines.get(elf) ?? null
    let engine: DwarfEngine | null = null
    try {
      const info = DwarfInfo.fromElf(elf)
      engine = info ? new DwarfEngine(elf, info) : null
    } catch {
      engine = null
    }
    engines.set(elf, engine)
    return engine
  }

  get addrSize(): number {
    return this.elf[4] === 2 ? 8 : 4
  }

  get cfi(): CallFrameInfo | null {
    if (this.cfiCache === undefined) {
      this.cfiCache = CallFrameInfo.parse(this.info.sections.frame, this.addrSize, this.info.little)
    }
    return this.cfiCache
  }

  /* ---------------------------------------------------------------- *
   * Where are we?
   * ---------------------------------------------------------------- */

  /** The scopes containing `pc`, outermost (the function) first. */
  scopeChain(pc: number): Die[] {
    const unit = this.info.unitForPc(pc)
    if (!unit) return []
    const root = this.info.tree(unit)
    if (!root) return []
    const chain: Die[] = []
    let node: Die = root
    for (let depth = 0; depth < 64; depth++) {
      let next: Die | null = null
      for (const child of node.children) {
        if (!SCOPE_TAGS.has(child.tag)) continue
        // A function nested in a function is not a scope of the outer one's
        // code, but GCC writes none for C; checking ranges covers it anyway.
        if (containsPc(dieRanges(this.info, child), pc)) {
          next = child
          break
        }
      }
      if (!next) break
      chain.push(next)
      node = next
    }
    return chain
  }

  /** The frames at `pc`, innermost first. Empty when the PC has no DWARF. */
  framesAt(pc: number): Frame[] {
    const chain = this.scopeChain(pc)
    if (chain.length === 0 || chain[0]!.tag !== TAG.subprogram) return []
    const subprogram = chain[0]!
    const frames: Frame[] = []
    let current: Frame | null = null
    for (const die of chain) {
      if (FRAME_TAGS.has(die.tag)) {
        current = {
          fn: die,
          scopes: [die],
          subprogram,
          name: this.info.name(die) ?? '??',
          inlined: die.tag === TAG.inlined_subroutine,
        }
        frames.push(current)
      } else if (current) {
        current.scopes.push(die)
      }
    }
    frames.reverse()

    // At the first instruction of an inlined call none of the callee has run,
    // and GDB (so VS Code) reports the stop in the caller, on the line of the
    // call, then steps into the callee from there. Several calls nested in
    // one another can all begin on the same instruction.
    while (frames.length > 1 && frames[0]!.inlined && this.entryPc(frames[0]!.fn) === pc) {
      frames.shift()
    }
    return frames
  }

  /** Where an inlined call begins: `DW_AT_entry_pc`, else its first address. */
  private entryPc(die: Die): number | null {
    const low = die.attrs.get(AT.low_pc)
    const base = low ? this.info.address(die.unit, low) : null
    const entry = die.attrs.get(AT.entry_pc)
    if (entry) {
      // An address, or since DWARF 5 an offset from the call's low_pc.
      if (entry.form === 'const') return base === null ? null : base + entry.value
      return this.info.address(die.unit, entry)
    }
    if (base !== null) return base
    const ranges = dieRanges(this.info, die)
    return ranges.length > 0 ? Math.min(...ranges.map(([lo]) => lo)) : null
  }

  /* ---------------------------------------------------------------- *
   * What does a name mean?
   * ---------------------------------------------------------------- */

  /**
   * `name` as C sees it in `frame`: the innermost block out to the function,
   * then the file, then the program. A null frame looks in the file and the
   * program only.
   */
  resolve(name: string, frame: Frame | null, unit: Unit | null): Variable | null {
    if (frame) {
      for (let i = frame.scopes.length - 1; i >= 0; i--) {
        for (const die of this.scopeMembers(frame.scopes[i]!)) {
          if (this.info.name(die) === name) return this.variable(die, name, frame)
        }
      }
      unit = frame.fn.unit
    }
    if (unit) {
      const root = this.info.tree(unit)
      let declared: Die | null = null
      for (const die of root?.children ?? []) {
        if (die.tag !== TAG.variable || this.info.name(die) !== name) continue
        if (!die.attrs.get(AT.declaration)) return this.variable(die, name, null)
        declared ??= die
      }
      // `extern` here: the definition is in the unit that owns it.
      const elsewhere = this.globalDefinition(name)
      if (elsewhere) return elsewhere
      if (declared) return this.variable(declared, name, null)
      return null
    }
    return this.globalDefinition(name)
  }

  private globalDefinition(name: string): Variable | null {
    let fallback: Die | null = null
    for (const entry of this.info.lookupName(name)) {
      if (entry.tag !== TAG.variable) continue
      let die = this.info.die(entry.offset)
      // A unit that declares `extern int x;` and then defines it writes the
      // definition as an unnamed DIE whose DW_AT_specification is the
      // declaration, so only the declaration is in the name index.
      if (die && !entry.defined) die = this.definitionOf(die)
      if (!die) continue
      if (this.info.attr(die, AT.location) || this.info.attr(die, AT.const_value)) {
        return this.variable(die, name, null)
      }
      fallback ??= die
    }
    return fallback ? this.variable(fallback, name, null) : null
  }

  private definitionOf(declaration: Die): Die | null {
    const root = this.info.tree(declaration.unit)
    for (const die of root?.children ?? []) {
      const spec = die.attrs.get(AT.specification)
      if (spec?.form === 'ref' && spec.offset === declaration.offset) return die
    }
    return null
  }

  /**
   * The variables a scope declares. A concrete scope (a function's code, an
   * inlined call) lists the ones the compiler kept; its abstract origin lists
   * them all, and the difference is what was optimized away.
   */
  private scopeMembers(scope: Die): Die[] {
    const own = scope.children.filter(isVariableDie)
    const origin = scope.attrs.get(AT.abstract_origin)
    if (origin?.form !== 'ref') return own
    const abstract = this.info.die(origin.offset)
    if (!abstract) return own
    const kept = new Set<number>()
    for (const die of own) {
      const ref = die.attrs.get(AT.abstract_origin)
      if (ref?.form === 'ref') kept.add(ref.offset)
    }
    const out = [...own]
    for (const die of abstract.children) {
      if (isVariableDie(die) && !kept.has(die.offset)) out.push(die)
    }
    return out
  }

  private variable(die: Die, name: string, frame: Frame | null): Variable {
    const kind: VarKind =
      die.tag === TAG.formal_parameter
        ? 'param'
        : frame === null
          ? die.parent?.tag === TAG.compile_unit && !this.info.flag(die, AT.external)
            ? 'static'
            : 'global'
          : isStaticStorage(this, die)
            ? 'static'
            : 'local'
    return { name, die, kind, frame }
  }

  /* ---------------------------------------------------------------- *
   * Where does it live?
   * ---------------------------------------------------------------- */

  /** Where `v` is at the target's PC. */
  async locate(v: Variable, target: FrameTarget): Promise<Location> {
    const attr = this.info.attr(v.die, AT.location)
    if (!attr) {
      const constant = this.info.attr(v.die, AT.const_value)
      if (constant) return constantLocation(constant, this.types.sizeOf(this.types.typeOf(v.die)))
      return { kind: 'unavailable', reason: OPTIMIZED_OUT }
    }
    const expr = locationAt(this.info, v.die, attr, target.pc)
    if (!expr) return { kind: 'unavailable', reason: OPTIMIZED_OUT }
    return evaluateLocation(expr, this.exprContext(v.die.unit, v.frame?.subprogram ?? null, target))
  }

  /** The canonical frame address at the PC: what `.debug_frame` says. */
  cfa(target: FrameTarget): bigint | null {
    const row = this.cfi?.rowAt(target.pc)
    if (!row) return null
    if (row.cfa.kind === 'reg') {
      const base = target.reg(row.cfa.reg)
      return base === null ? null : base + BigInt(row.cfa.offset)
    }
    return null
  }

  private exprContext(unit: Unit, subprogram: Die | null, target: FrameTarget): ExprContext {
    const ctx: ExprContext = {
      addrSize: unit.addrSize,
      little: this.info.little,
      reg: (n) => target.reg(n),
      cfa: () => this.cfa(target),
      read: (addr, size) => target.read(Number(addr), size),
      addrx: (index) => this.info.addrx(unit, index),
      frameBase: async () => {
        if (!subprogram) return null
        const attr = subprogram.attrs.get(AT.frame_base)
        if (!attr) return null
        const expr = locationAt(this.info, subprogram, attr, target.pc)
        if (!expr) return null
        // The frame base is not itself in a frame: no fbreg inside it.
        const loc = await evaluateLocation(expr, { ...ctx, frameBase: async () => null })
        if (loc.kind === 'memory') return loc.addr
        if (loc.kind === 'register') return target.reg(loc.reg)
        if (loc.kind === 'value') return loc.value
        return null
      },
    }
    return ctx
  }

}

function isVariableDie(die: Die): boolean {
  return die.tag === TAG.variable || die.tag === TAG.formal_parameter
}

/** A `static` inside a function: its location is a fixed address. */
function isStaticStorage(engine: DwarfEngine, die: Die): boolean {
  const attr = engine.info.attr(die, AT.location)
  return attr?.form === 'block' && attr.bytes.length === engine.addrSize + 1 && attr.bytes[0] === 0x03
}

/** `DW_AT_const_value`: the value itself, with no storage behind it. */
function constantLocation(attr: AttrValue, size: number | null): Location {
  if (attr.form === 'block') return { kind: 'implicit', bytes: attr.bytes }
  if (attr.form === 'string') return { kind: 'implicit', bytes: new TextEncoder().encode(`${attr.value}\0`) }
  if (attr.form === 'const') {
    const n = size ?? (attr.size || 8)
    const bytes = new Uint8Array(n)
    let v = BigInt.asUintN(n * 8, attr.big)
    for (let i = 0; i < n; i++) {
      bytes[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return { kind: 'implicit', bytes }
  }
  return { kind: 'unavailable', reason: OPTIMIZED_OUT }
}
