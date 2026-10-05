/**
 * `.debug_info` as a tree of DIEs, one compilation unit at a time.
 *
 * The other DWARF reader here walks the section once for one answer (a
 * struct's member offsets). Reading a variable needs the tree itself: scopes
 * nest, a concrete function names nothing and points at its abstract origin
 * for that, and a type is a chain of references. So this one parses a unit
 * into DIE objects the first time something asks about it, and keeps it. Only
 * the unit holding the PC, and the units a lookup leads to, are ever parsed: a
 * 5 MB `.debug_info` costs nothing until a hover needs it.
 *
 * Handles DWARF 2 to 5, both offset sizes, and the DWARF 5 index forms
 * (strx, addrx, loclistx, rnglistx) with their unit bases, although GCC's
 * non-split output, which every image the page ships uses, has none of them.
 */

import { findSection } from '@/debug/elfSections'
import { AT, FORM, TAG } from '@/debug/dwarf/constants'
import { dieRanges, liveRange } from '@/debug/dwarf/ranges'
import { DwarfReader, stringAt } from '@/debug/dwarf/reader'

export interface DwarfSections {
  info: Uint8Array
  abbrev: Uint8Array
  str: Uint8Array | null
  lineStr: Uint8Array | null
  strOffsets: Uint8Array | null
  addr: Uint8Array | null
  loclists: Uint8Array | null
  loc: Uint8Array | null
  rnglists: Uint8Array | null
  ranges: Uint8Array | null
  frame: Uint8Array | null
  aranges: Uint8Array | null
  line: Uint8Array | null
}

/** A decoded attribute value. `ref` offsets are absolute in `.debug_info`. */
export type AttrValue =
  | { form: 'addr'; value: number }
  | { form: 'addrx'; index: number }
  | { form: 'const'; value: number; big: bigint; size: number; signed: boolean }
  | { form: 'block'; bytes: Uint8Array }
  | { form: 'string'; value: string }
  | { form: 'strx'; index: number }
  | { form: 'ref'; offset: number }
  | { form: 'secoffset'; value: number }
  | { form: 'loclistx'; index: number }
  | { form: 'rnglistx'; index: number }
  | { form: 'flag'; value: boolean }
  | { form: 'other' }

export interface Die {
  offset: number
  tag: number
  attrs: Map<number, AttrValue>
  children: Die[]
  parent: Die | null
  unit: Unit
}

export interface Unit {
  offset: number
  /** One past the unit's last byte. */
  end: number
  version: number
  /** DW_UT_*; DWARF 4 and earlier read as DW_UT_compile. */
  unitType: number
  addrSize: number
  offsetSize: 4 | 8
  abbrevOffset: number
  firstDie: number
  /* From the unit DIE, once it has been read. */
  baseAddress: number
  strOffsetsBase: number
  addrBase: number
  loclistsBase: number
  rnglistsBase: number
  stmtList: number | null
  root: Die | null
  dies: Map<number, Die> | null
}

interface AbbrevAttr {
  name: number
  form: number
  implicit: number
}

interface Abbrev {
  tag: number
  children: boolean
  attrs: AbbrevAttr[]
}

const DW_UT_compile = 0x01
const DW_UT_type = 0x02
const DW_UT_skeleton = 0x04
const DW_UT_split_compile = 0x05
const DW_UT_split_type = 0x06

/** Tags whose name is worth indexing across units for a global lookup. */
const INDEXED_TAGS = new Set<number>([
  TAG.variable,
  TAG.structure_type,
  TAG.union_type,
  TAG.enumeration_type,
  TAG.typedef,
])

export interface NameEntry {
  offset: number
  tag: number
  /** A definition, not a `DW_AT_declaration`. */
  defined: boolean
}

export class DwarfInfo {
  readonly units: Unit[]
  private readonly abbrevCache = new Map<number, Map<number, Abbrev>>()
  private arangeTable: { lo: number; hi: number; unit: Unit }[] | null = null
  private nameIndex: Map<string, NameEntry[]> | null = null

  private constructor(
    readonly sections: DwarfSections,
    readonly little: boolean,
  ) {
    this.units = readUnitHeaders(sections.info, little)
  }

  /** The image's DWARF, or null when it has none (a stripped ELF). */
  static fromElf(elf: Uint8Array): DwarfInfo | null {
    const bytes = (name: string): Uint8Array | null => {
      const section = findSection(elf, name)
      return section ? elf.subarray(section.offset, section.offset + section.size) : null
    }
    const info = bytes('.debug_info')
    const abbrev = bytes('.debug_abbrev')
    if (!info || !abbrev || info.length === 0) return null
    return new DwarfInfo(
      {
        info,
        abbrev,
        str: bytes('.debug_str'),
        lineStr: bytes('.debug_line_str'),
        strOffsets: bytes('.debug_str_offsets'),
        addr: bytes('.debug_addr'),
        loclists: bytes('.debug_loclists'),
        loc: bytes('.debug_loc'),
        rnglists: bytes('.debug_rnglists'),
        ranges: bytes('.debug_ranges'),
        frame: bytes('.debug_frame'),
        aranges: bytes('.debug_aranges'),
        line: bytes('.debug_line'),
      },
      elf[5] === 1,
    )
  }

  /* ---------------------------------------------------------------- *
   * Units and DIEs
   * ---------------------------------------------------------------- */

  /** The unit whose bytes contain `offset`. */
  unitContaining(offset: number): Unit | null {
    let lo = 0
    let hi = this.units.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const unit = this.units[mid]!
      if (offset < unit.offset) hi = mid - 1
      else if (offset >= unit.end) lo = mid + 1
      else return unit
    }
    return null
  }

  /** The unit's DIE tree, parsed on first use. */
  tree(unit: Unit): Die | null {
    if (!unit.dies) this.parseUnit(unit)
    return unit.root
  }

  /** The DIE at an absolute `.debug_info` offset. */
  die(offset: number): Die | null {
    const unit = this.unitContaining(offset)
    if (!unit) return null
    if (!unit.dies) this.parseUnit(unit)
    return unit.dies?.get(offset) ?? null
  }

  /**
   * The compile unit covering `pc`: `.debug_aranges` first, which GCC always
   * writes, then each unit's own ranges for a toolchain that did not.
   */
  unitForPc(pc: number): Unit | null {
    if (!this.arangeTable) this.arangeTable = this.readAranges()
    let lo = 0
    let hi = this.arangeTable.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const entry = this.arangeTable[mid]!
      if (pc < entry.lo) hi = mid - 1
      else if (pc >= entry.hi) lo = mid + 1
      else return entry.unit
    }
    return null
  }

  private parseUnit(unit: Unit): void {
    const abbrevs = this.abbrevs(unit.abbrevOffset)
    const r = new DwarfReader(this.sections.info, unit.firstDie, this.little)
    const dies = new Map<number, Die>()
    unit.dies = dies
    const stack: Die[] = []
    while (r.at < unit.end) {
      const offset = r.at
      const code = r.uleb()
      if (code === 0) {
        stack.pop()
        if (stack.length === 0 && unit.root) break
        continue
      }
      const abbrev = abbrevs.get(code)
      if (!abbrev) break
      const attrs = new Map<number, AttrValue>()
      for (const spec of abbrev.attrs) {
        attrs.set(spec.name, this.readForm(r, spec.form, spec.implicit, unit))
      }
      const parent = stack[stack.length - 1] ?? null
      const die: Die = { offset, tag: abbrev.tag, attrs, children: [], parent, unit }
      dies.set(offset, die)
      if (parent) parent.children.push(die)
      else if (!unit.root) {
        unit.root = die
        this.readUnitBases(unit, die)
      }
      if (abbrev.children) stack.push(die)
      else if (!parent) break
    }
  }

  /**
   * The unit DIE alone, with the unit's bases set from it, for the lookups
   * that must not pay for the whole tree (the aranges fallback, the name
   * index). Not added to the unit's DIE map.
   */
  private rootOnly(unit: Unit): Die | null {
    if (unit.root) return unit.root
    const abbrevs = this.abbrevs(unit.abbrevOffset)
    const r = new DwarfReader(this.sections.info, unit.firstDie, this.little)
    const offset = r.at
    const abbrev = abbrevs.get(r.uleb())
    if (!abbrev) return null
    const attrs = new Map<number, AttrValue>()
    for (const spec of abbrev.attrs) {
      attrs.set(spec.name, this.readForm(r, spec.form, spec.implicit, unit))
    }
    const die: Die = { offset, tag: abbrev.tag, attrs, children: [], parent: null, unit }
    this.readUnitBases(unit, die)
    return die
  }

  /** Bases and the base address come from the unit DIE's own attributes. */
  private readUnitBases(unit: Unit, root: Die): void {
    const num = (at: number): number | null => {
      const v = root.attrs.get(at)
      if (!v) return null
      if (v.form === 'secoffset' || v.form === 'const') return v.value
      return null
    }
    unit.strOffsetsBase = num(AT.str_offsets_base) ?? (unit.version >= 5 ? 8 : 0)
    unit.addrBase = num(AT.addr_base) ?? (unit.version >= 5 ? 8 : 0)
    unit.loclistsBase = num(AT.loclists_base) ?? 0
    unit.rnglistsBase = num(AT.rnglists_base) ?? 0
    unit.stmtList = num(AT.stmt_list)
    // The bases must be in place before an addrx low_pc can be resolved.
    const low = root.attrs.get(AT.low_pc)
    unit.baseAddress = low ? (this.address(unit, low) ?? 0) : 0
  }

  private abbrevs(offset: number): Map<number, Abbrev> {
    const cached = this.abbrevCache.get(offset)
    if (cached) return cached
    const table = new Map<number, Abbrev>()
    const r = new DwarfReader(this.sections.abbrev, offset, this.little)
    while (!r.done) {
      const code = r.uleb()
      if (code === 0) break
      const tag = r.uleb()
      const children = r.u8() !== 0
      const attrs: AbbrevAttr[] = []
      for (;;) {
        const name = r.uleb()
        const form = r.uleb()
        if (name === 0 && form === 0) break
        const implicit = form === FORM.implicit_const ? r.sleb() : 0
        attrs.push({ name, form, implicit })
      }
      table.set(code, { tag, children, attrs })
    }
    this.abbrevCache.set(offset, table)
    return table
  }

  private readForm(r: DwarfReader, form: number, implicit: number, unit: Unit): AttrValue {
    const cnst = (value: number, big: bigint, size: number, signed = false): AttrValue => ({
      form: 'const',
      value,
      big,
      size,
      signed,
    })
    switch (form) {
      case FORM.addr:
        return { form: 'addr', value: r.addr(unit.addrSize) }
      case FORM.addrx:
        return { form: 'addrx', index: r.uleb() }
      case FORM.addrx1:
        return { form: 'addrx', index: r.u8() }
      case FORM.addrx2:
        return { form: 'addrx', index: r.u16() }
      case FORM.addrx3:
        return { form: 'addrx', index: r.u24() }
      case FORM.addrx4:
        return { form: 'addrx', index: r.u32() }
      case FORM.data1: {
        const v = r.u8()
        return cnst(v, BigInt(v), 1)
      }
      case FORM.data2: {
        const v = r.u16()
        return cnst(v, BigInt(v), 2)
      }
      case FORM.data4: {
        const v = r.u32()
        // DWARF 2 and 3 used data4 for section offsets as well.
        if (unit.version < 4) return { form: 'secoffset', value: v }
        return cnst(v, BigInt(v), 4)
      }
      case FORM.data8: {
        const big = r.u64Big()
        if (unit.version < 4) return { form: 'secoffset', value: Number(big) }
        return cnst(Number(big), big, 8)
      }
      case FORM.data16:
        return { form: 'block', bytes: r.bytes(16) }
      case FORM.sdata: {
        const big = r.slebBig()
        return cnst(Number(big), big, 0, true)
      }
      case FORM.udata: {
        const big = r.ulebBig()
        return cnst(Number(big), big, 0)
      }
      case FORM.implicit_const:
        return cnst(implicit, BigInt(implicit), 0, true)
      case FORM.string:
        return { form: 'string', value: r.cstring() }
      case FORM.strp:
        return { form: 'string', value: stringAt(this.sections.str, r.offset(unit.offsetSize)) }
      case FORM.line_strp:
        return { form: 'string', value: stringAt(this.sections.lineStr, r.offset(unit.offsetSize)) }
      case FORM.strx:
        return { form: 'strx', index: r.uleb() }
      case FORM.strx1:
        return { form: 'strx', index: r.u8() }
      case FORM.strx2:
        return { form: 'strx', index: r.u16() }
      case FORM.strx3:
        return { form: 'strx', index: r.u24() }
      case FORM.strx4:
        return { form: 'strx', index: r.u32() }
      case FORM.ref1:
        return { form: 'ref', offset: unit.offset + r.u8() }
      case FORM.ref2:
        return { form: 'ref', offset: unit.offset + r.u16() }
      case FORM.ref4:
        return { form: 'ref', offset: unit.offset + r.u32() }
      case FORM.ref8:
        return { form: 'ref', offset: unit.offset + r.u64() }
      case FORM.ref_udata:
        return { form: 'ref', offset: unit.offset + r.uleb() }
      case FORM.ref_addr:
        // DWARF 2 sized this as an address; 3 and later as an offset.
        return {
          form: 'ref',
          offset: unit.version <= 2 ? r.addr(unit.addrSize) : r.offset(unit.offsetSize),
        }
      case FORM.sec_offset:
        return { form: 'secoffset', value: r.offset(unit.offsetSize) }
      case FORM.exprloc:
        return { form: 'block', bytes: r.bytes(r.uleb()) }
      case FORM.block1:
        return { form: 'block', bytes: r.bytes(r.u8()) }
      case FORM.block2:
        return { form: 'block', bytes: r.bytes(r.u16()) }
      case FORM.block4:
        return { form: 'block', bytes: r.bytes(r.u32()) }
      case FORM.block:
        return { form: 'block', bytes: r.bytes(r.uleb()) }
      case FORM.flag:
        return { form: 'flag', value: r.u8() !== 0 }
      case FORM.flag_present:
        return { form: 'flag', value: true }
      case FORM.loclistx:
        return { form: 'loclistx', index: r.uleb() }
      case FORM.rnglistx:
        return { form: 'rnglistx', index: r.uleb() }
      case FORM.ref_sig8:
        r.skip(8)
        return { form: 'other' }
      case FORM.ref_sup4:
      case FORM.strp_sup:
        r.skip(4)
        return { form: 'other' }
      case FORM.ref_sup8:
        r.skip(8)
        return { form: 'other' }
      case FORM.indirect: {
        const actual = r.uleb()
        return this.readForm(r, actual, implicit, unit)
      }
      default:
        // An unknown form has an unknown size: nothing after it can be read.
        throw new Error(`DWARF form 0x${form.toString(16)} not understood`)
    }
  }

  /* ---------------------------------------------------------------- *
   * Attribute access
   * ---------------------------------------------------------------- */

  /**
   * An attribute of `die`, or of the DIE it completes: a concrete function or
   * variable leaves its name and type to `DW_AT_abstract_origin`, and an
   * out-of-line definition to `DW_AT_specification`.
   */
  attr(die: Die, at: number): AttrValue | undefined {
    let current: Die | null = die
    for (let hops = 0; current && hops < 8; hops++) {
      const value = current.attrs.get(at)
      if (value) return value
      const next: AttrValue | undefined =
        current.attrs.get(AT.abstract_origin) ?? current.attrs.get(AT.specification)
      current = next?.form === 'ref' ? this.die(next.offset) : null
    }
    return undefined
  }

  /** The DIE an attribute refers to (`DW_AT_type`, `DW_AT_abstract_origin`, …). */
  ref(die: Die, at: number): Die | null {
    const value = this.attr(die, at)
    return value?.form === 'ref' ? this.die(value.offset) : null
  }

  string(die: Die, at: number): string | null {
    const value = this.attr(die, at)
    if (!value) return null
    if (value.form === 'string') return value.value
    if (value.form === 'strx') return this.strx(die.unit, value.index)
    return null
  }

  name(die: Die): string | null {
    return this.string(die, AT.name)
  }

  flag(die: Die, at: number): boolean {
    const value = this.attr(die, at)
    return value?.form === 'flag' ? value.value : false
  }

  /** A constant attribute as a number, or null. */
  constant(die: Die, at: number): number | null {
    const value = this.attr(die, at)
    if (value?.form === 'const') return value.value
    return null
  }

  /** An address-class value, resolving an index through `.debug_addr`. */
  address(unit: Unit, value: AttrValue): number | null {
    if (value.form === 'addr') return value.value
    if (value.form === 'addrx') return this.addrx(unit, value.index)
    return null
  }

  addrx(unit: Unit, index: number): number | null {
    const section = this.sections.addr
    if (!section) return null
    const at = unit.addrBase + index * unit.addrSize
    if (at + unit.addrSize > section.length) return null
    return new DwarfReader(section, at, this.little).addr(unit.addrSize)
  }

  private strx(unit: Unit, index: number): string | null {
    const section = this.sections.strOffsets
    if (!section) return null
    const at = unit.strOffsetsBase + index * unit.offsetSize
    if (at + unit.offsetSize > section.length) return null
    const offset = new DwarfReader(section, at, this.little).offset(unit.offsetSize)
    return stringAt(this.sections.str, offset)
  }

  /* ---------------------------------------------------------------- *
   * Lookups across units
   * ---------------------------------------------------------------- */

  /**
   * DIEs named `name` at the top level of any unit: globals, file statics and
   * types. The index is built on the first lookup, by one pass over every
   * unit's top-level DIEs that decodes nothing but names, and costs about what
   * the struct-offset reader already pays per query.
   */
  lookupName(name: string): NameEntry[] {
    if (!this.nameIndex) this.nameIndex = this.buildNameIndex()
    return this.nameIndex.get(name) ?? []
  }

  private buildNameIndex(): Map<string, NameEntry[]> {
    const index = new Map<string, NameEntry[]>()
    for (const unit of this.units) {
      try {
        this.scanTopLevel(unit, index)
      } catch {
        // A unit this reader cannot walk costs its own names.
      }
    }
    return index
  }

  private scanTopLevel(unit: Unit, index: Map<string, NameEntry[]>): void {
    // A strx name needs the unit's str_offsets_base, which is on the unit DIE.
    if (!this.rootOnly(unit)) return
    const abbrevs = this.abbrevs(unit.abbrevOffset)
    const r = new DwarfReader(this.sections.info, unit.firstDie, this.little)
    let depth = 0
    let rootSeen = false
    while (r.at < unit.end) {
      const offset = r.at
      const code = r.uleb()
      if (code === 0) {
        depth--
        if (depth <= 0 && rootSeen) return
        continue
      }
      const abbrev = abbrevs.get(code)
      if (!abbrev) return
      const wanted = depth === 1 && INDEXED_TAGS.has(abbrev.tag)
      let name: string | null = null
      let declaration = false
      let sibling: number | null = null
      for (const spec of abbrev.attrs) {
        if (wanted && spec.name === AT.name) {
          const value = this.readForm(r, spec.form, spec.implicit, unit)
          if (value.form === 'string') name = value.value
          else if (value.form === 'strx') name = this.strx(unit, value.index)
        } else if (wanted && spec.name === AT.declaration) {
          const value = this.readForm(r, spec.form, spec.implicit, unit)
          declaration = value.form === 'flag' && value.value
        } else if (spec.name === AT.sibling && depth >= 1) {
          const value = this.readForm(r, spec.form, spec.implicit, unit)
          if (value.form === 'ref') sibling = value.offset
        } else {
          this.skipForm(r, spec.form, unit)
        }
      }
      if (!rootSeen) {
        rootSeen = true
        if (!abbrev.children) return
        depth = 1
        continue
      }
      if (wanted && name) {
        const list = index.get(name)
        const entry = { offset, tag: abbrev.tag, defined: !declaration }
        if (list) list.push(entry)
        else index.set(name, [entry])
      }
      if (abbrev.children) {
        // Below the top level nothing is indexed, so a sibling pointer lets
        // the whole subtree go unread.
        if (depth === 1 && sibling !== null && sibling > r.at && sibling <= unit.end) {
          r.at = sibling
        } else {
          depth++
        }
      }
    }
  }

  private skipForm(r: DwarfReader, form: number, unit: Unit): void {
    switch (form) {
      case FORM.addr:
        r.skip(unit.addrSize)
        return
      case FORM.data1:
      case FORM.ref1:
      case FORM.flag:
      case FORM.strx1:
      case FORM.addrx1:
        r.skip(1)
        return
      case FORM.data2:
      case FORM.ref2:
      case FORM.strx2:
      case FORM.addrx2:
        r.skip(2)
        return
      case FORM.strx3:
      case FORM.addrx3:
        r.skip(3)
        return
      case FORM.data4:
      case FORM.ref4:
      case FORM.strx4:
      case FORM.addrx4:
      case FORM.ref_sup4:
      case FORM.strp_sup:
        r.skip(4)
        return
      case FORM.data8:
      case FORM.ref8:
      case FORM.ref_sig8:
      case FORM.ref_sup8:
        r.skip(8)
        return
      case FORM.data16:
        r.skip(16)
        return
      case FORM.strp:
      case FORM.line_strp:
      case FORM.sec_offset:
        r.skip(unit.offsetSize)
        return
      case FORM.ref_addr:
        r.skip(unit.version <= 2 ? unit.addrSize : unit.offsetSize)
        return
      case FORM.string:
        r.cstring()
        return
      case FORM.sdata:
      case FORM.udata:
      case FORM.ref_udata:
      case FORM.strx:
      case FORM.addrx:
      case FORM.loclistx:
      case FORM.rnglistx:
        r.uleb()
        return
      case FORM.exprloc:
      case FORM.block:
        r.skip(r.uleb())
        return
      case FORM.block1:
        r.skip(r.u8())
        return
      case FORM.block2:
        r.skip(r.u16())
        return
      case FORM.block4:
        r.skip(r.u32())
        return
      case FORM.flag_present:
      case FORM.implicit_const:
        return
      case FORM.indirect:
        this.skipForm(r, r.uleb(), unit)
        return
      default:
        throw new Error(`DWARF form 0x${form.toString(16)} not understood`)
    }
  }

  private readAranges(): { lo: number; hi: number; unit: Unit }[] {
    const out: { lo: number; hi: number; unit: Unit }[] = []
    const covered = new Set<Unit>()
    const section = this.sections.aranges
    if (section) {
      const r = new DwarfReader(section, 0, this.little)
      while (r.at + 4 <= section.length) {
        const start = r.at
        let length = r.u32()
        let offsetSize: 4 | 8 = 4
        if (length === 0xffffffff) {
          length = r.u64()
          offsetSize = 8
        }
        const end = r.at + length
        if (length === 0 || end > section.length) break
        r.u16() // version
        const cuOffset = r.offset(offsetSize)
        const addrSize = r.u8()
        const segSize = r.u8()
        const tuple = addrSize * 2 + segSize
        // Tuples start at a multiple of their own size from the set's start.
        const headerEnd = r.at - start
        r.at = start + Math.ceil(headerEnd / tuple) * tuple
        const unit = this.unitContaining(cuOffset)
        while (r.at + tuple <= end) {
          r.skip(segSize)
          const lo = r.addr(addrSize)
          const len = r.addr(addrSize)
          if (lo === 0 && len === 0) break
          if (unit && liveRange(lo, lo + len)) out.push({ lo, hi: lo + len, unit })
        }
        if (unit) covered.add(unit)
        r.at = end
      }
    }
    // Units the table left out (a toolchain that writes no aranges) are found
    // by their own ranges.
    for (const unit of this.units) {
      if (covered.has(unit) || unit.unitType !== DW_UT_compile) continue
      try {
        const root = this.rootOnly(unit)
        if (!root) continue
        for (const [lo, hi] of dieRanges(this, root)) out.push({ lo, hi, unit })
      } catch {
        // A unit this reader cannot open covers nothing.
      }
    }
    out.sort((a, b) => a.lo - b.lo || a.hi - b.hi)
    return out
  }
}

function readUnitHeaders(info: Uint8Array, little: boolean): Unit[] {
  const units: Unit[] = []
  const r = new DwarfReader(info, 0, little)
  while (r.at + 11 <= info.length) {
    const offset = r.at
    let length = r.u32()
    let offsetSize: 4 | 8 = 4
    if (length === 0xffffffff) {
      length = r.u64()
      offsetSize = 8
    }
    const end = r.at + length
    if (length === 0 || end > info.length) break
    const version = r.u16()
    let unitType = DW_UT_compile
    let addrSize: number
    let abbrevOffset: number
    if (version >= 5) {
      unitType = r.u8()
      addrSize = r.u8()
      abbrevOffset = r.offset(offsetSize)
      if (unitType === DW_UT_skeleton || unitType === DW_UT_split_compile) r.skip(8)
      else if (unitType === DW_UT_type || unitType === DW_UT_split_type) {
        r.skip(8)
        r.offset(offsetSize)
      }
    } else {
      abbrevOffset = r.offset(offsetSize)
      addrSize = r.u8()
    }
    units.push({
      offset,
      end,
      version,
      unitType,
      addrSize,
      offsetSize,
      abbrevOffset,
      firstDie: r.at,
      baseAddress: 0,
      strOffsetsBase: 0,
      addrBase: 0,
      loclistsBase: 0,
      rnglistsBase: 0,
      stmtList: null,
      root: null,
      dies: null,
    })
    r.at = end
  }
  return units
}
