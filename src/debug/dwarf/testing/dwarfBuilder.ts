/**
 * A small DWARF assembler for tests: a DIE tree in, `.debug_info` and
 * `.debug_abbrev` out, wrapped in a 32-bit little-endian ELF.
 *
 * The real images are a release asset and absent in CI, so the engine's tests
 * need DWARF they can build themselves; byte arrays written out by hand would
 * be unreadable past a dozen DIEs.
 */

import { FORM } from '@/debug/dwarf/constants'

export function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

export function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

export function uleb(value: number): number[] {
  const out: number[] = []
  let rest = value
  do {
    let byte = rest & 0x7f
    rest = Math.floor(rest / 128)
    if (rest !== 0) byte |= 0x80
    out.push(byte)
  } while (rest !== 0)
  return out
}

export function sleb(value: number): number[] {
  const out: number[] = []
  let rest = value
  for (;;) {
    const byte = rest & 0x7f
    rest >>= 7
    if ((rest === 0 && !(byte & 0x40)) || (rest === -1 && byte & 0x40)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

export function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

/** An attribute value: a number, a string, raw bytes (exprloc), a DIE id. */
export type AttrSpec = number | string | number[] | { ref: string } | true

export interface DieSpec {
  tag: number
  /** `[DW_AT, DW_FORM, value]` in order. */
  attrs: Array<[number, number, AttrSpec]>
  children?: DieSpec[]
  /** A name other DIEs refer to with `{ ref: id }`. */
  id?: string
}

/** One DWARF 5 compile unit, as `.debug_info` and `.debug_abbrev`. */
export function assembleUnit(root: DieSpec): { info: Uint8Array; abbrev: Uint8Array } {
  const abbrevs = new Map<string, number>()
  const abbrevBytes: number[] = []
  const body: number[] = []
  const ids = new Map<string, number>()
  const patches: Array<{ at: number; id: string }> = []
  const HEADER = 12

  const abbrevFor = (die: DieSpec): number => {
    const children = (die.children?.length ?? 0) > 0
    const key = `${die.tag}:${children}:${die.attrs.map(([at, form]) => `${at}/${form}`).join(',')}`
    let code = abbrevs.get(key)
    if (code === undefined) {
      code = abbrevs.size + 1
      abbrevs.set(key, code)
      abbrevBytes.push(...uleb(code), ...uleb(die.tag), children ? 1 : 0)
      for (const [at, form] of die.attrs) abbrevBytes.push(...uleb(at), ...uleb(form))
      abbrevBytes.push(0, 0)
    }
    return code
  }

  const emit = (die: DieSpec) => {
    if (die.id) ids.set(die.id, HEADER + body.length)
    body.push(...uleb(abbrevFor(die)))
    for (const [, form, value] of die.attrs) body.push(...encode(form, value, body.length, patches))
    if (die.children?.length) {
      for (const child of die.children) emit(child)
      body.push(0)
    }
  }
  emit(root)
  abbrevBytes.push(0)

  for (const { at, id } of patches) {
    const offset = ids.get(id)
    if (offset === undefined) throw new Error(`no DIE with id ${id}`)
    body.splice(at, 4, ...u32(offset))
  }
  const unitLength = 2 + 1 + 1 + 4 + body.length
  const info = [...u32(unitLength), ...u16(5), 0x01, 4, ...u32(0), ...body]
  return { info: new Uint8Array(info), abbrev: new Uint8Array(abbrevBytes) }
}

function encode(
  form: number,
  value: AttrSpec,
  at: number,
  patches: Array<{ at: number; id: string }>,
): number[] {
  switch (form) {
    case FORM.string:
      return [...ascii(String(value)), 0]
    case FORM.data1:
      return [Number(value) & 0xff]
    case FORM.data2:
      return u16(Number(value))
    case FORM.data4:
    case FORM.addr:
    case FORM.sec_offset:
      return u32(Number(value))
    case FORM.sdata:
      return sleb(Number(value))
    case FORM.udata:
      return uleb(Number(value))
    case FORM.flag_present:
      return []
    case FORM.exprloc: {
      const bytes = value as number[]
      return [...uleb(bytes.length), ...bytes]
    }
    case FORM.ref4: {
      patches.push({ at, id: (value as { ref: string }).ref })
      return u32(0)
    }
    default:
      throw new Error(`form 0x${form.toString(16)} not supported by the test assembler`)
  }
}

/** A DWARF 5 `.debug_loclists` / `.debug_rnglists` section around list bytes. */
export function listSection(lists: number[]): { bytes: Uint8Array; first: number } {
  const header = [...u16(5), 4, 0, ...u32(0)]
  return { bytes: new Uint8Array([...u32(header.length + lists.length), ...header, ...lists]), first: 12 }
}

/** Wrap sections in a minimal 32-bit little-endian ELF. */
export function makeElf(sections: Record<string, Uint8Array>): Uint8Array {
  const names = ['', ...Object.keys(sections), '.shstrtab']
  const shstrtab: number[] = []
  const nameOffsets = new Map<string, number>()
  for (const name of names) {
    nameOffsets.set(name, shstrtab.length)
    shstrtab.push(...ascii(name), 0)
  }

  const EHDR = 52
  const SHENT = 40
  const count = names.length
  const shoff = EHDR
  let cursor = shoff + count * SHENT

  const bodies: Array<{ name: string; data: Uint8Array; offset: number }> = []
  for (const [name, data] of Object.entries(sections)) {
    bodies.push({ name, data, offset: cursor })
    cursor += data.length
  }
  const shstrOffset = cursor
  cursor += shstrtab.length

  const out = new Uint8Array(cursor)
  const dv = new DataView(out.buffer)
  out.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0)
  dv.setUint16(18, 40, true) // e_machine: EM_ARM
  dv.setUint32(32, shoff, true) // e_shoff
  dv.setUint16(46, SHENT, true) // e_shentsize
  dv.setUint16(48, count, true) // e_shnum
  dv.setUint16(50, count - 1, true) // e_shstrndx

  const writeHeader = (index: number, name: string, offset: number, size: number) => {
    const at = shoff + index * SHENT
    dv.setUint32(at, nameOffsets.get(name)!, true)
    dv.setUint32(at + 4, 1, true) // SHT_PROGBITS
    dv.setUint32(at + 16, offset, true)
    dv.setUint32(at + 20, size, true)
  }
  writeHeader(0, '', 0, 0)
  bodies.forEach((body, i) => {
    out.set(body.data, body.offset)
    writeHeader(i + 1, body.name, body.offset, body.data.length)
  })
  out.set(shstrtab, shstrOffset)
  writeHeader(count - 1, '.shstrtab', shstrOffset, shstrtab.length)
  return out
}
