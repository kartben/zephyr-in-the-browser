/**
 * DWARF formal-parameter names for the subprogram containing a PC.
 *
 * Best-effort: handles DW_AT_low_pc + DW_AT_high_pc (addr or offset). Skips
 * units that only use DW_AT_ranges. Returns [] when .debug_info is missing.
 */

import { findSection } from '@/debug/elfSections'

function uleb(data: Uint8Array, i: { at: number }): number {
  let result = 0
  let shift = 0
  for (;;) {
    const b = data[i.at++]!
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 35) break
  }
  return result >>> 0
}

function sleb(data: Uint8Array, i: { at: number }): number {
  let result = 0
  let shift = 0
  let b = 0
  for (;;) {
    b = data[i.at++]!
    result |= (b & 0x7f) << shift
    shift += 7
    if ((b & 0x80) === 0) break
    if (shift > 35) break
  }
  if (shift < 32 && b & 0x40) result |= (~0 << shift) >>> 0
  return result | 0
}

function skipForm(
  data: Uint8Array,
  i: { at: number },
  form: number,
  addrSize: number,
  little: boolean,
): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (o: number) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false))
  const u32 = (o: number) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false))
  switch (form) {
    case 0x01:
      i.at += addrSize
      return
    case 0x03:
      i.at += 2 + u16(i.at)
      return
    case 0x04:
      i.at += 4 + u32(i.at)
      return
    case 0x05:
      i.at += 2
      return
    case 0x06:
    case 0x0e:
    case 0x10:
    case 0x13:
    case 0x17:
    case 0x1c:
    case 0x1d:
    case 0x1f:
      i.at += 4
      return
    case 0x07:
    case 0x14:
    case 0x20:
    case 0x24:
      i.at += 8
      return
    case 0x08:
      while (i.at < data.length && data[i.at++] !== 0) {
        /* */
      }
      return
    case 0x09: {
      const n = uleb(data, i)
      i.at += n
      return
    }
    case 0x0a:
      i.at += 1 + (data[i.at] ?? 0)
      return
    case 0x0b:
    case 0x0c:
    case 0x11:
    case 0x25:
    case 0x29:
      i.at += 1
      return
    case 0x0d:
      sleb(data, i)
      return
    case 0x0f:
    case 0x15:
    case 0x1a:
    case 0x1b:
    case 0x22:
    case 0x23:
      uleb(data, i)
      return
    case 0x12:
    case 0x26:
    case 0x2a:
      i.at += 2
      return
    case 0x16: {
      const inner = uleb(data, i)
      skipForm(data, i, inner, addrSize, little)
      return
    }
    case 0x18: {
      const n = uleb(data, i)
      i.at += n
      return
    }
    case 0x19:
    case 0x21:
      return
    case 0x1e:
      i.at += 16
      return
    case 0x27:
    case 0x2b:
      i.at += 3
      return
    case 0x28:
    case 0x2c:
      i.at += 4
      return
    default:
      return
  }
}

type Attr = { name: number; form: number; implicit: number | null }
type Abbr = { tag: number; children: boolean; attrs: Attr[] }

function parseAbbrevs(abbrevData: Uint8Array, abbrevOffset: number): Map<number, Abbr> {
  const abbrevs = new Map<number, Abbr>()
  if (abbrevOffset >= abbrevData.length) return abbrevs
  const cursor = { at: abbrevOffset }
  while (cursor.at < abbrevData.length) {
    const code = uleb(abbrevData, cursor)
    if (code === 0) break
    const tag = uleb(abbrevData, cursor)
    const children = abbrevData[cursor.at++]! !== 0
    const attrs: Attr[] = []
    for (;;) {
      const an = uleb(abbrevData, cursor)
      const af = uleb(abbrevData, cursor)
      if (an === 0 && af === 0) break
      let implicit: number | null = null
      if (af === 0x21) implicit = sleb(abbrevData, cursor)
      attrs.push({ name: an, form: af, implicit })
    }
    abbrevs.set(code, { tag, children, attrs })
  }
  return abbrevs
}

export interface DwarfSubprogram {
  name: string
  low: number
  high: number
  formals: string[]
}

export interface FormalIndex {
  /** Sorted by low address. */
  subs: DwarfSubprogram[]
}

function readAddr(
  data: Uint8Array,
  at: { at: number },
  form: number,
  addrSize: number,
  little: boolean,
): number | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (form === 0x01) {
    if (addrSize === 8) {
      const lo = little ? dv.getUint32(at.at, true) : dv.getUint32(at.at, false)
      const hi = little ? dv.getUint32(at.at + 4, true) : dv.getUint32(at.at + 4, false)
      at.at += 8
      return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
    }
    const v = little ? dv.getUint32(at.at, true) : dv.getUint32(at.at, false)
    at.at += 4
    return v >>> 0
  }
  // data1/2/4/8 / udata as constant address (rare for low_pc)
  if (form === 0x0b) return data[at.at++]!
  if (form === 0x05) {
    const v = little ? dv.getUint16(at.at, true) : dv.getUint16(at.at, false)
    at.at += 2
    return v
  }
  if (form === 0x06) {
    const v = little ? dv.getUint32(at.at, true) : dv.getUint32(at.at, false)
    at.at += 4
    return v >>> 0
  }
  if (form === 0x0f) return uleb(data, at)
  skipForm(data, at, form, addrSize, little)
  return null
}

function readConst(
  data: Uint8Array,
  at: { at: number },
  form: number,
  addrSize: number,
  little: boolean,
  implicit: number | null,
): number | null {
  if (form === 0x21 && implicit !== null) return implicit
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (form === 0x0b) return data[at.at++]!
  if (form === 0x05) {
    const v = little ? dv.getUint16(at.at, true) : dv.getUint16(at.at, false)
    at.at += 2
    return v
  }
  if (form === 0x06) {
    const v = little ? dv.getUint32(at.at, true) : dv.getUint32(at.at, false)
    at.at += 4
    return v >>> 0
  }
  if (form === 0x07) {
    const lo = little ? dv.getUint32(at.at, true) : dv.getUint32(at.at, false)
    at.at += 8
    return lo >>> 0
  }
  if (form === 0x0f) return uleb(data, at)
  if (form === 0x0d) return sleb(data, at)
  skipForm(data, at, form, addrSize, little)
  return null
}

/** Build an index of subprograms with formal names. Empty when DWARF absent. */
export function buildFormalIndex(elf: Uint8Array): FormalIndex | null {
  const info = findSection(elf, '.debug_info')
  const abbrevSec = findSection(elf, '.debug_abbrev')
  const strSec = findSection(elf, '.debug_str')
  if (!info || !abbrevSec) return null

  const little = elf[5] === 1
  const infoData = elf.subarray(info.offset, info.offset + info.size)
  const abbrevData = elf.subarray(abbrevSec.offset, abbrevSec.offset + abbrevSec.size)
  const strData = strSec ? elf.subarray(strSec.offset, strSec.offset + strSec.size) : null
  const dv = new DataView(infoData.buffer, infoData.byteOffset, infoData.byteLength)
  const u32 = (o: number) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false))
  const u16 = (o: number) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false))
  const dec = new TextDecoder()
  const subs: DwarfSubprogram[] = []

  let cu = 0
  while (cu + 11 < infoData.length) {
    const unitLength = u32(cu)
    if (unitLength === 0xffffffff || unitLength === 0) break
    const cuEnd = cu + 4 + unitLength
    const version = u16(cu + 4)
    let offs = cu + 6
    let abbrevOffset: number
    let addrSize: number
    if (version >= 5) {
      offs += 1
      addrSize = infoData[offs++]!
      abbrevOffset = u32(offs)
      offs += 4
    } else {
      abbrevOffset = u32(offs)
      offs += 4
      addrSize = infoData[offs++]!
    }

    const abbrevs = parseAbbrevs(abbrevData, abbrevOffset)

    const readStr = (form: number, at: { at: number }): string | null => {
      if (form === 0x08) {
        const start = at.at
        while (at.at < infoData.length && infoData[at.at++] !== 0) {
          /* */
        }
        return dec.decode(infoData.subarray(start, at.at - 1))
      }
      if (form === 0x0e && strData) {
        const off = u32(at.at)
        at.at += 4
        let end = off
        while (end < strData.length && strData[end] !== 0) end++
        return dec.decode(strData.subarray(off, end))
      }
      return null
    }

    const at = { at: offs }
    while (at.at < cuEnd) {
      const code = uleb(infoData, at)
      if (code === 0) continue
      const abbr = abbrevs.get(code)
      if (!abbr) break

      // DW_TAG_subprogram = 0x2e
      if (abbr.tag === 0x2e) {
        let name: string | null = null
        let low: number | null = null
        let high: number | null = null
        let highIsOffset = false

        for (const attr of abbr.attrs) {
          if (attr.name === 0x03) {
            const s = readStr(attr.form, at)
            if (s !== null) name = s
            else skipForm(infoData, at, attr.form, addrSize, little)
          } else if (attr.name === 0x11) {
            // DW_AT_low_pc
            low = readAddr(infoData, at, attr.form, addrSize, little)
          } else if (attr.name === 0x12) {
            // DW_AT_high_pc — addr or constant offset from low
            if (
              attr.form === 0x0b ||
              attr.form === 0x05 ||
              attr.form === 0x06 ||
              attr.form === 0x07 ||
              attr.form === 0x0f ||
              attr.form === 0x0d ||
              attr.form === 0x21
            ) {
              high = readConst(infoData, at, attr.form, addrSize, little, attr.implicit)
              highIsOffset = true
            } else {
              high = readAddr(infoData, at, attr.form, addrSize, little)
              highIsOffset = false
            }
          } else {
            skipForm(infoData, at, attr.form, addrSize, little)
          }
        }

        const formals: string[] = []
        if (abbr.children) {
          let depth = 1
          while (at.at < cuEnd && depth > 0) {
            const ccode = uleb(infoData, at)
            if (ccode === 0) {
              depth--
              continue
            }
            const cabbr = abbrevs.get(ccode)
            if (!cabbr) break
            let cname: string | null = null
            for (const attr of cabbr.attrs) {
              if (attr.name === 0x03 && depth === 1) {
                const s = readStr(attr.form, at)
                if (s !== null) cname = s
                else skipForm(infoData, at, attr.form, addrSize, little)
              } else {
                skipForm(infoData, at, attr.form, addrSize, little)
              }
            }
            // DW_TAG_formal_parameter = 0x05
            if (depth === 1 && cabbr.tag === 0x05 && cname) formals.push(cname)
            if (cabbr.children) depth++
          }
        }

        if (name && low != null && high != null) {
          const hi = highIsOffset ? low + high : high
          if (hi > low) subs.push({ name, low, high: hi, formals })
        }
        continue
      }

      // Non-subprogram DIE: skip attrs, then nested children.
      for (const attr of abbr.attrs) {
        skipForm(infoData, at, attr.form, addrSize, little)
      }
      if (abbr.children) {
        let depth = 1
        while (at.at < cuEnd && depth > 0) {
          const ccode = uleb(infoData, at)
          if (ccode === 0) {
            depth--
            continue
          }
          const cabbr = abbrevs.get(ccode)
          if (!cabbr) break
          for (const attr of cabbr.attrs) {
            skipForm(infoData, at, attr.form, addrSize, little)
          }
          if (cabbr.children) depth++
        }
      }
    }
    cu = cuEnd
  }

  if (subs.length === 0) return null
  subs.sort((a, b) => a.low - b.low || a.high - b.high)
  return { subs }
}

/** Formals for the tightest subprogram containing `pc`. */
export function formalsAt(index: FormalIndex | null, pc: number): string[] {
  if (!index || !Number.isFinite(pc)) return []
  let best: DwarfSubprogram | null = null
  for (const s of index.subs) {
    if (pc >= s.low && pc < s.high) {
      if (!best || s.high - s.low < best.high - best.low) best = s
    }
  }
  return best?.formals ?? []
}
