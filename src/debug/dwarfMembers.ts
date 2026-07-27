/**
 * Minimal DWARF reader: member byte-offsets for one named struct.
 *
 * Host-only helper for `k_thread.stack_info` when the guest ELF was built with
 * CONFIG_THREAD_STACK_INFO (DWARF present). Returns {} when .debug_info is
 * absent or the walk fails — callers fall back to ELF stack-symbol matching.
 */

function findSection(
  data: Uint8Array,
  name: string,
): { offset: number; size: number } | null {
  if (data.length < 64 || data[0] !== 0x7f) return null
  const elfclass = data[4] as 1 | 2
  const little = data[5] === 1
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (o: number) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false))
  const u32 = (o: number) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false))
  const u64 = (o: number) => {
    const lo = u32(o)
    const hi = u32(o + 4)
    return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
  }

  const eShoff = elfclass === 2 ? u64(40) : u32(32)
  const eShentsize = elfclass === 2 ? u16(58) : u16(46)
  const eShnum = elfclass === 2 ? u16(60) : u16(48)
  const eShstrndx = elfclass === 2 ? u16(62) : u16(50)
  const strSh = eShoff + eShstrndx * eShentsize
  const strOff = elfclass === 2 ? u64(strSh + 24) : u32(strSh + 16)
  const strSize = elfclass === 2 ? u64(strSh + 32) : u32(strSh + 20)
  const shstr = data.subarray(strOff, strOff + strSize)
  const dec = new TextDecoder()

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    const nameOff = u32(sh)
    let end = nameOff
    while (end < shstr.length && shstr[end] !== 0) end++
    const n = dec.decode(shstr.subarray(nameOff, end))
    if (n !== name) continue
    return {
      offset: elfclass === 2 ? u64(sh + 24) : u32(sh + 16),
      size: elfclass === 2 ? u64(sh + 32) : u32(sh + 20),
    }
  }
  return null
}

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

/** Skip a form in a DIE. `implicit` is the abbrev-side value for implicit_const. */
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
    case 0x01: // addr
      i.at += addrSize
      return
    case 0x03: // block2
      i.at += 2 + u16(i.at)
      return
    case 0x04: // block4
      i.at += 4 + u32(i.at)
      return
    case 0x05: // data2
      i.at += 2
      return
    case 0x06: // data4
    case 0x0e: // strp
    case 0x10: // ref_addr (DWARF4: 4 in 32-bit dwarf)
    case 0x13: // ref4
    case 0x17: // sec_offset
      i.at += 4
      return
    case 0x07: // data8
    case 0x14: // ref8
    case 0x20: // ref_sig8
      i.at += 8
      return
    case 0x08: // string
      while (i.at < data.length && data[i.at++] !== 0) {
        /* */
      }
      return
    case 0x09: {
      // block
      const n = uleb(data, i)
      i.at += n
      return
    }
    case 0x0a: // block1
      i.at += 1 + (data[i.at] ?? 0)
      return
    case 0x0b: // data1
    case 0x0c: // flag
    case 0x11: // ref1
      i.at += 1
      return
    case 0x0d: // sdata
      sleb(data, i)
      return
    case 0x0f: // udata
    case 0x15: // ref_udata
    case 0x1a: // strx
    case 0x1b: // addrx
    case 0x22: // loclistx
    case 0x23: // rnglistx
      uleb(data, i)
      return
    case 0x12: // ref2
      i.at += 2
      return
    case 0x16: {
      // indirect
      const inner = uleb(data, i)
      skipForm(data, i, inner, addrSize, little)
      return
    }
    case 0x18: {
      // exprloc
      const n = uleb(data, i)
      i.at += n
      return
    }
    case 0x19: // flag_present
    case 0x21: // implicit_const (value lives in abbrev)
      return
    case 0x1e: // data16
      i.at += 16
      return
    case 0x25: // strx1
    case 0x29: // addrx1
      i.at += 1
      return
    case 0x26: // strx2
    case 0x2a: // addrx2
      i.at += 2
      return
    case 0x27: // strx3
    case 0x2b: // addrx3
      i.at += 3
      return
    case 0x28: // strx4
    case 0x2c: // addrx4
    case 0x1c: // ref_sup4
    case 0x1d: // strp_sup
    case 0x1f: // line_strp
      i.at += 4
      return
    case 0x24: // ref_sup8
      i.at += 8
      return
    default:
      // Unknown — bail by not advancing forever; caller may desync.
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

/**
 * Return member name → byte offset for the first DW_TAG_structure_type matching
 * `structName`. Empty when DWARF is missing or the walk fails.
 */
export function dwarfStructMembers(elf: Uint8Array, structName: string): Record<string, number> {
  const info = findSection(elf, '.debug_info')
  const abbrevSec = findSection(elf, '.debug_abbrev')
  const strSec = findSection(elf, '.debug_str')
  if (!info || !abbrevSec) return {}

  const little = elf[5] === 1
  const infoData = elf.subarray(info.offset, info.offset + info.size)
  const abbrevData = elf.subarray(abbrevSec.offset, abbrevSec.offset + abbrevSec.size)
  const strData = strSec ? elf.subarray(strSec.offset, strSec.offset + strSec.size) : null
  const dv = new DataView(infoData.buffer, infoData.byteOffset, infoData.byteLength)
  const u32 = (o: number) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false))
  const u16 = (o: number) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false))
  const dec = new TextDecoder()

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
      offs += 1 // unit_type
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

    const readMemberLoc = (form: number, at: { at: number }, implicit: number | null): number | null => {
      if (form === 0x21 && implicit !== null) return implicit
      if (form === 0x0b) return infoData[at.at++]!
      if (form === 0x05) {
        const v = u16(at.at)
        at.at += 2
        return v
      }
      if (form === 0x06) {
        const v = u32(at.at)
        at.at += 4
        return v
      }
      if (form === 0x07) {
        const lo = u32(at.at)
        at.at += 8
        return lo
      }
      if (form === 0x0f) return uleb(infoData, at)
      if (form === 0x0d) return sleb(infoData, at)
      // exprloc / block: DW_OP_plus_uconst (0x23)
      if (form === 0x18 || form === 0x09 || form === 0x0a || form === 0x03 || form === 0x04) {
        let n: number
        if (form === 0x0a) n = infoData[at.at++]!
        else if (form === 0x03) {
          n = u16(at.at)
          at.at += 2
        } else if (form === 0x04) {
          n = u32(at.at)
          at.at += 4
        } else n = uleb(infoData, at)
        const start = at.at
        at.at += n
        if (n >= 2 && infoData[start] === 0x23) {
          const c = { at: start + 1 }
          return uleb(infoData, c)
        }
        return null
      }
      skipForm(infoData, at, form, addrSize, little)
      return null
    }

    const at = { at: offs }
    while (at.at < cuEnd) {
      const code = uleb(infoData, at)
      if (code === 0) continue
      const abbr = abbrevs.get(code)
      if (!abbr) break

      let dieName: string | null = null
      for (const attr of abbr.attrs) {
        if (attr.name === 0x03) {
          const s = readStr(attr.form, at)
          if (s !== null) dieName = s
          else skipForm(infoData, at, attr.form, addrSize, little)
        } else {
          skipForm(infoData, at, attr.form, addrSize, little)
        }
      }

      // DW_TAG_structure_type / class_type
      if ((abbr.tag === 0x13 || abbr.tag === 0x02) && dieName === structName && abbr.children) {
        const members: Record<string, number> = {}
        let depth = 1
        while (at.at < cuEnd && depth > 0) {
          const ccode = uleb(infoData, at)
          if (ccode === 0) {
            depth--
            continue
          }
          const cabbr = abbrevs.get(ccode)
          if (!cabbr) return members
          let cname: string | null = null
          let cloc: number | null = null
          for (const attr of cabbr.attrs) {
            if (attr.name === 0x03) {
              const s = readStr(attr.form, at)
              if (s !== null) cname = s
              else skipForm(infoData, at, attr.form, addrSize, little)
            } else if (attr.name === 0x38) {
              cloc = readMemberLoc(attr.form, at, attr.implicit)
            } else {
              skipForm(infoData, at, attr.form, addrSize, little)
            }
          }
          if (depth === 1 && cabbr.tag === 0x0d && cname != null && cloc != null) {
            members[cname] = cloc
          }
          if (cabbr.children) depth++
        }
        if (Object.keys(members).length > 0) return members
      }
    }
    cu = cuEnd
  }
  return {}
}
