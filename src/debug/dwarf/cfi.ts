/**
 * `.debug_frame`: where each function's frame is, instruction by instruction.
 *
 * Every function in the shipped images names its frame base
 * `DW_OP_call_frame_cfa`, so a local on the stack is "CFA - 24" and the CFA
 * itself is only known by running the function's call-frame program up to the
 * PC: at the first instruction it is the stack pointer, after the prologue's
 * push it is the stack pointer plus what was pushed, and so on. This reader
 * runs that program and reports the rule in force; it also keeps the
 * register rules, which a caller-frame unwinder would need, although nothing
 * reads them yet.
 *
 * `.debug_frame` only: the images carry no `.eh_frame`, and a `.debug_frame`
 * CIE says `0xffffffff` where an `.eh_frame` one says 0.
 */

import { liveRange } from '@/debug/dwarf/ranges'
import { DwarfReader } from '@/debug/dwarf/reader'

export type CfaRule =
  | { kind: 'reg'; reg: number; offset: number }
  | { kind: 'expr'; expr: Uint8Array }

export type RegRule =
  | { kind: 'undefined' }
  | { kind: 'same' }
  | { kind: 'offset'; offset: number }
  | { kind: 'val_offset'; offset: number }
  | { kind: 'register'; reg: number }
  | { kind: 'expr'; expr: Uint8Array }
  | { kind: 'val_expr'; expr: Uint8Array }

export interface FrameRow {
  cfa: CfaRule
  regs: Map<number, RegRule>
  /** The column that holds the return address. */
  returnReg: number
}

interface Cie {
  codeAlign: number
  dataAlign: number
  returnReg: number
  addrSize: number
  initial: Uint8Array
  augmentationData: boolean
}

interface Fde {
  lo: number
  hi: number
  cie: Cie
  program: Uint8Array
}

export class CallFrameInfo {
  private readonly fdes: Fde[]

  private constructor(fdes: Fde[]) {
    this.fdes = fdes.sort((a, b) => a.lo - b.lo)
  }

  /** Parse a `.debug_frame` section. Null when it is absent or empty. */
  static parse(section: Uint8Array | null, addrSize: number, little = true): CallFrameInfo | null {
    if (!section || section.length === 0) return null
    const cies = new Map<number, Cie>()
    const fdes: Fde[] = []
    const r = new DwarfReader(section, 0, little)
    while (r.at + 4 <= section.length) {
      const start = r.at
      let length = r.u32()
      let offsetSize: 4 | 8 = 4
      if (length === 0xffffffff) {
        length = r.u64()
        offsetSize = 8
      }
      if (length === 0) continue
      const end = r.at + length
      if (end > section.length) break
      const idAt = r.at
      const id = r.offset(offsetSize)
      const isCie = offsetSize === 8 ? id === 2 ** 64 - 1 : id === 0xffffffff
      try {
        if (isCie) {
          const cie = readCie(r, end, addrSize)
          if (cie) cies.set(start, cie)
        } else {
          let cie = cies.get(id)
          if (!cie) {
            // A CIE after its FDE is legal; read it where it is.
            const back = new DwarfReader(section, id, little)
            let cieLength = back.u32()
            let cieOffsetSize: 4 | 8 = 4
            if (cieLength === 0xffffffff) {
              cieLength = back.u64()
              cieOffsetSize = 8
            }
            const cieEnd = back.at + cieLength
            back.offset(cieOffsetSize)
            cie = readCie(back, cieEnd, addrSize) ?? undefined
            if (cie) cies.set(id, cie)
          }
          if (cie) {
            r.at = idAt + offsetSize
            const lo = r.addr(cie.addrSize)
            const range = r.addr(cie.addrSize)
            if (cie.augmentationData) r.skip(r.uleb())
            // A dropped function's FDE is relocated to 0: see liveRange().
            if (liveRange(lo, lo + range)) {
              fdes.push({ lo, hi: lo + range, cie, program: section.subarray(r.at, end) })
            }
          }
        }
      } catch {
        // A malformed entry costs that function's frame; the rest still read.
      }
      r.at = end
    }
    return new CallFrameInfo(fdes)
  }

  /** The row in force at `pc`, or null when no FDE covers it. */
  rowAt(pc: number): FrameRow | null {
    const fde = this.fdeFor(pc)
    if (!fde) return null
    const { cie } = fde
    const initial: FrameRow = {
      cfa: { kind: 'reg', reg: 0, offset: 0 },
      regs: new Map(),
      returnReg: cie.returnReg,
    }
    // The CIE's instructions set the state every FDE starts from, and that
    // state is what DW_CFA_restore goes back to.
    run(cie.initial, cie, initial, null, fde.lo, Infinity)
    const startRegs = new Map(initial.regs)
    const row: FrameRow = { cfa: initial.cfa, regs: new Map(initial.regs), returnReg: cie.returnReg }
    run(fde.program, cie, row, startRegs, fde.lo, pc)
    return row
  }

  private fdeFor(pc: number): Fde | null {
    let lo = 0
    let hi = this.fdes.length - 1
    let found: Fde | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const fde = this.fdes[mid]!
      if (fde.lo <= pc) {
        found = fde
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found && pc < found.hi ? found : null
  }
}

function readCie(r: DwarfReader, end: number, defaultAddrSize: number): Cie | null {
  const version = r.u8()
  const augmentation = r.cstring()
  let addrSize = defaultAddrSize
  if (version >= 4) {
    addrSize = r.u8()
    r.u8() // segment_selector_size
  }
  const codeAlign = r.uleb()
  const dataAlign = r.sleb()
  const returnReg = version === 1 ? r.u8() : r.uleb()
  let augmentationData = false
  if (augmentation.startsWith('z')) {
    augmentationData = true
    r.skip(r.uleb())
  } else if (augmentation !== '') {
    // An augmentation this reader does not know changes the layout after it.
    return null
  }
  return { codeAlign, dataAlign, returnReg, addrSize, initial: r.data.subarray(r.at, end), augmentationData }
}

/**
 * Run call-frame instructions on `row`, stopping before the first advance that
 * would move past `pc`. `startRegs` is the CIE's state, for DW_CFA_restore;
 * null while running the CIE itself.
 */
function run(
  program: Uint8Array,
  cie: Cie,
  row: FrameRow,
  startRegs: Map<number, RegRule> | null,
  startLoc: number,
  pc: number,
): void {
  const r = new DwarfReader(program, 0)
  const stack: { cfa: CfaRule; regs: Map<number, RegRule> }[] = []
  let loc = startLoc
  const advance = (delta: number): boolean => {
    const next = loc + delta * cie.codeAlign
    if (next > pc) return false
    loc = next
    return true
  }
  const restore = (reg: number) => {
    const rule = startRegs?.get(reg)
    if (rule) row.regs.set(reg, rule)
    else row.regs.delete(reg)
  }
  const setCfaOffset = (offset: number) => {
    if (row.cfa.kind === 'reg') row.cfa = { ...row.cfa, offset }
  }
  while (!r.done) {
    const op = r.u8()
    const high = op & 0xc0
    const low = op & 0x3f
    if (high === 0x40) {
      if (!advance(low)) return
      continue
    }
    if (high === 0x80) {
      row.regs.set(low, { kind: 'offset', offset: r.uleb() * cie.dataAlign })
      continue
    }
    if (high === 0xc0) {
      restore(low)
      continue
    }
    switch (op) {
      case 0x00: // nop
        break
      case 0x01: {
        // set_loc
        const next = r.addr(cie.addrSize)
        if (next > pc) return
        loc = next
        break
      }
      case 0x02:
        if (!advance(r.u8())) return
        break
      case 0x03:
        if (!advance(r.u16())) return
        break
      case 0x04:
        if (!advance(r.u32())) return
        break
      case 0x05: // offset_extended
        row.regs.set(r.uleb(), { kind: 'offset', offset: r.uleb() * cie.dataAlign })
        break
      case 0x06: // restore_extended
        restore(r.uleb())
        break
      case 0x07: // undefined
        row.regs.set(r.uleb(), { kind: 'undefined' })
        break
      case 0x08: // same_value
        row.regs.set(r.uleb(), { kind: 'same' })
        break
      case 0x09: {
        // register
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'register', reg: r.uleb() })
        break
      }
      case 0x0a: // remember_state
        stack.push({ cfa: row.cfa, regs: new Map(row.regs) })
        break
      case 0x0b: {
        // restore_state
        const saved = stack.pop()
        if (saved) {
          row.cfa = saved.cfa
          row.regs = saved.regs
        }
        break
      }
      case 0x0c: {
        // def_cfa
        const reg = r.uleb()
        row.cfa = { kind: 'reg', reg, offset: r.uleb() }
        break
      }
      case 0x0d: {
        // def_cfa_register
        const reg = r.uleb()
        row.cfa = { kind: 'reg', reg, offset: row.cfa.kind === 'reg' ? row.cfa.offset : 0 }
        break
      }
      case 0x0e: // def_cfa_offset
        setCfaOffset(r.uleb())
        break
      case 0x0f: // def_cfa_expression
        row.cfa = { kind: 'expr', expr: r.bytes(r.uleb()) }
        break
      case 0x10: {
        // expression
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'expr', expr: r.bytes(r.uleb()) })
        break
      }
      case 0x11: {
        // offset_extended_sf
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'offset', offset: r.sleb() * cie.dataAlign })
        break
      }
      case 0x12: {
        // def_cfa_sf
        const reg = r.uleb()
        row.cfa = { kind: 'reg', reg, offset: r.sleb() * cie.dataAlign }
        break
      }
      case 0x13: // def_cfa_offset_sf
        setCfaOffset(r.sleb() * cie.dataAlign)
        break
      case 0x14: {
        // val_offset
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'val_offset', offset: r.uleb() * cie.dataAlign })
        break
      }
      case 0x15: {
        // val_offset_sf
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'val_offset', offset: r.sleb() * cie.dataAlign })
        break
      }
      case 0x16: {
        // val_expression
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'val_expr', expr: r.bytes(r.uleb()) })
        break
      }
      case 0x2d: // GNU_window_save / AARCH64_negate_ra_state: no operands
        break
      case 0x2e: // GNU_args_size
        r.uleb()
        break
      case 0x2f: {
        // GNU_negative_offset_extended
        const reg = r.uleb()
        row.regs.set(reg, { kind: 'offset', offset: -r.uleb() * cie.dataAlign })
        break
      }
      default:
        // An opcode with unknown operands: nothing after it can be trusted.
        return
    }
  }
}
