/**
 * The address ranges a DIE covers: a function, an inlined call, a block.
 *
 * Three spellings: `low_pc` with `high_pc` (an address, or a length since
 * DWARF 4), and `DW_AT_ranges`, which points into `.debug_rnglists` (DWARF 5)
 * or `.debug_ranges` (DWARF 2 to 4). GCC writes ranges for anything it split,
 * which at -O2 is most inlined calls and many blocks.
 */

import { AT, RLE } from '@/debug/dwarf/constants'
import type { Die, DwarfInfo, Unit } from '@/debug/dwarf/info'
import { DwarfReader } from '@/debug/dwarf/reader'

export type Range = [lo: number, hi: number]

/**
 * A function the linker dropped (`--gc-sections`) keeps its DWARF, relocated
 * to address 0. No image this page boots runs code at 0 (Cortex-M keeps its
 * vector table there), and on Cortex-M real code follows soon after, where a
 * dropped function's `[0, size)` would overlap it. So a range starting at 0
 * is never a real one.
 */
export function liveRange(lo: number, hi: number): boolean {
  return lo !== 0 && hi > lo
}

export function dieRanges(info: DwarfInfo, die: Die): Range[] {
  return rawDieRanges(info, die).filter(([lo, hi]) => liveRange(lo, hi))
}

function rawDieRanges(info: DwarfInfo, die: Die): Range[] {
  const low = die.attrs.get(AT.low_pc)
  const high = die.attrs.get(AT.high_pc)
  if (low && high) {
    const lo = info.address(die.unit, low)
    if (lo === null) return []
    const hi = high.form === 'const' ? lo + high.value : info.address(die.unit, high)
    return hi !== null && hi > lo ? [[lo, hi]] : []
  }
  const ranges = die.attrs.get(AT.ranges)
  if (!ranges) {
    // A lone low_pc is a single address (a label); it covers nothing.
    return []
  }
  if (ranges.form === 'rnglistx') {
    const offset = listOffset(info, die.unit, ranges.index, die.unit.rnglistsBase, info.sections.rnglists)
    return offset === null ? [] : readRngList(info, die.unit, offset)
  }
  if (ranges.form !== 'secoffset' && ranges.form !== 'const') return []
  if (die.unit.version >= 5) {
    // A unit DIE's own DW_AT_ranges is an offset from the section start; so is
    // every sec_offset. Only rnglistx is relative to rnglists_base.
    return readRngList(info, die.unit, ranges.value)
  }
  return readRangesV4(info, die.unit, ranges.value)
}

export function containsPc(ranges: readonly Range[], pc: number): boolean {
  for (const [lo, hi] of ranges) if (pc >= lo && pc < hi) return true
  return false
}

/**
 * The offset an `x` index names, through the offset table that follows a
 * `.debug_loclists` / `.debug_rnglists` header. `base` points just past the
 * header, at the table itself.
 */
export function listOffset(
  info: DwarfInfo,
  unit: Unit,
  index: number,
  base: number,
  section: Uint8Array | null,
): number | null {
  if (!section) return null
  const at = base + index * unit.offsetSize
  if (at + unit.offsetSize > section.length) return null
  return base + new DwarfReader(section, at, info.little).offset(unit.offsetSize)
}

function readRngList(info: DwarfInfo, unit: Unit, offset: number): Range[] {
  const section = info.sections.rnglists
  if (!section || offset >= section.length) return []
  const r = new DwarfReader(section, offset, info.little)
  const out: Range[] = []
  let base = unit.baseAddress
  for (let guard = 0; guard < 4096 && !r.done; guard++) {
    const kind = r.u8()
    switch (kind) {
      case RLE.end_of_list:
        return out
      case RLE.base_addressx:
        base = info.addrx(unit, r.uleb()) ?? 0
        break
      case RLE.startx_endx: {
        const lo = info.addrx(unit, r.uleb())
        const hi = info.addrx(unit, r.uleb())
        if (lo !== null && hi !== null && hi > lo) out.push([lo, hi])
        break
      }
      case RLE.startx_length: {
        const lo = info.addrx(unit, r.uleb())
        const len = r.uleb()
        if (lo !== null && len > 0) out.push([lo, lo + len])
        break
      }
      case RLE.offset_pair: {
        const lo = base + r.uleb()
        const hi = base + r.uleb()
        if (hi > lo) out.push([lo, hi])
        break
      }
      case RLE.base_address:
        base = r.addr(unit.addrSize)
        break
      case RLE.start_end: {
        const lo = r.addr(unit.addrSize)
        const hi = r.addr(unit.addrSize)
        if (hi > lo) out.push([lo, hi])
        break
      }
      case RLE.start_length: {
        const lo = r.addr(unit.addrSize)
        const len = r.uleb()
        if (len > 0) out.push([lo, lo + len])
        break
      }
      default:
        return out
    }
  }
  return out
}

function readRangesV4(info: DwarfInfo, unit: Unit, offset: number): Range[] {
  const section = info.sections.ranges
  if (!section || offset >= section.length) return []
  const r = new DwarfReader(section, offset, info.little)
  const size = unit.addrSize
  const max = size === 8 ? 2 ** 64 - 1 : 0xffffffff
  const out: Range[] = []
  let base = unit.baseAddress
  for (let guard = 0; guard < 4096 && !r.done; guard++) {
    const lo = r.addr(size)
    const hi = r.addr(size)
    if (lo === 0 && hi === 0) break
    // A base address selection entry.
    if (lo === max) {
      base = hi
      continue
    }
    if (hi > lo) out.push([base + lo, base + hi])
  }
  return out
}
