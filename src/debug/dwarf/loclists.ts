/**
 * Which location expression describes a variable at a given PC.
 *
 * An optimised build moves a variable around as its function runs: `evt` in
 * the button sample starts in r0, moves to r4 across a call, and between the
 * two exists only as "whatever r0 held on entry", which nothing can read back.
 * DWARF says so with a location list, one expression per address range, and a
 * PC no entry covers is a PC where the variable has no value at all.
 */

import { LLE } from '@/debug/dwarf/constants'
import type { AttrValue, Die, DwarfInfo, Unit } from '@/debug/dwarf/info'
import { listOffset } from '@/debug/dwarf/ranges'
import { DwarfReader } from '@/debug/dwarf/reader'

/**
 * The expression for `pc`. `null` means the list has no entry for this PC, so
 * the variable is optimized out here; `undefined` means the attribute is not a
 * location at all.
 */
export function locationAt(
  info: DwarfInfo,
  die: Die,
  attr: AttrValue,
  pc: number,
): Uint8Array | null | undefined {
  if (attr.form === 'block') return attr.bytes
  const unit = die.unit
  if (attr.form === 'loclistx') {
    const offset = listOffset(info, unit, attr.index, unit.loclistsBase, info.sections.loclists)
    return offset === null ? null : readLocList(info, unit, offset, pc)
  }
  if (attr.form !== 'secoffset' && attr.form !== 'const') return undefined
  return unit.version >= 5
    ? readLocList(info, unit, attr.value, pc)
    : readLocV4(info, unit, attr.value, pc)
}

function readLocList(info: DwarfInfo, unit: Unit, offset: number, pc: number): Uint8Array | null {
  const section = info.sections.loclists
  if (!section || offset >= section.length) return null
  const r = new DwarfReader(section, offset, info.little)
  let base = unit.baseAddress
  let fallback: Uint8Array | null = null
  const expr = () => r.bytes(r.uleb())
  for (let guard = 0; guard < 4096 && !r.done; guard++) {
    const kind = r.u8()
    let lo: number | null = null
    let hi: number | null = null
    switch (kind) {
      case LLE.end_of_list:
        return fallback
      case LLE.base_addressx:
        base = info.addrx(unit, r.uleb()) ?? 0
        continue
      case LLE.base_address:
        base = r.addr(unit.addrSize)
        continue
      case LLE.startx_endx:
        lo = info.addrx(unit, r.uleb())
        hi = info.addrx(unit, r.uleb())
        break
      case LLE.startx_length: {
        lo = info.addrx(unit, r.uleb())
        const len = r.uleb()
        hi = lo === null ? null : lo + len
        break
      }
      case LLE.offset_pair:
        lo = base + r.uleb()
        hi = base + r.uleb()
        break
      case LLE.start_end:
        lo = r.addr(unit.addrSize)
        hi = r.addr(unit.addrSize)
        break
      case LLE.start_length: {
        lo = r.addr(unit.addrSize)
        hi = lo + r.uleb()
        break
      }
      case LLE.default_location:
        fallback = expr()
        continue
      default:
        return fallback
    }
    const bytes = expr()
    if (lo !== null && hi !== null && pc >= lo && pc < hi) return bytes
  }
  return fallback
}

function readLocV4(info: DwarfInfo, unit: Unit, offset: number, pc: number): Uint8Array | null {
  const section = info.sections.loc
  if (!section || offset >= section.length) return null
  const r = new DwarfReader(section, offset, info.little)
  const size = unit.addrSize
  const max = size === 8 ? 2 ** 64 - 1 : 0xffffffff
  let base = unit.baseAddress
  for (let guard = 0; guard < 4096 && !r.done; guard++) {
    const lo = r.addr(size)
    const hi = r.addr(size)
    if (lo === 0 && hi === 0) return null
    if (lo === max) {
      base = hi
      continue
    }
    const bytes = r.bytes(r.u16())
    if (pc >= base + lo && pc < base + hi) return bytes
  }
  return null
}
