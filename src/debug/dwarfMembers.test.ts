import { describe, expect, it } from 'vitest'
import { dwarfStruct, dwarfStructMembers } from '@/debug/dwarfMembers'

/** ELF64 little-endian carrying only the named sections, enough for findSection. */
function elfWithSections(sections: Record<string, Uint8Array>): Uint8Array {
  const names = ['', '.shstrtab', ...Object.keys(sections)]
  const nameOffsets: number[] = []
  let shstr = ''
  for (const name of names) {
    nameOffsets.push(shstr.length)
    shstr += name + '\0'
  }
  const bodies = [new Uint8Array(0), new TextEncoder().encode(shstr), ...Object.values(sections)]

  const shoff = 64
  let dataAt = shoff + names.length * 64
  const buf = new Uint8Array(dataAt + bodies.reduce((n, b) => n + b.length, 0))
  const dv = new DataView(buf.buffer)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  dv.setUint32(40, shoff, true)
  dv.setUint16(58, 64, true) // e_shentsize
  dv.setUint16(60, names.length, true) // e_shnum
  dv.setUint16(62, 1, true) // e_shstrndx
  bodies.forEach((body, i) => {
    const sh = shoff + i * 64
    dv.setUint32(sh, nameOffsets[i]!, true)
    dv.setUint32(sh + 24, dataAt, true) // sh_offset
    dv.setUint32(sh + 32, body.length, true) // sh_size
    buf.set(body, dataAt)
    dataAt += body.length
  })
  return buf
}

const cstr = (s: string) => [...new TextEncoder().encode(s), 0]

/**
 * One DWARF 4 compile unit with two structs: k_mutex (byte size as data1) and
 * k_thread (byte size as data2, as GCC emits it past 255 bytes).
 */
function zephyrDwarf(): Uint8Array {
  const abbrev = new Uint8Array([
    1, 0x11, 1, 0, 0, // compile_unit, children, no attributes
    2, 0x13, 1, 0x03, 0x08, 0x0b, 0x0b, 0, 0, // structure_type: name string, byte_size data1
    3, 0x13, 1, 0x03, 0x08, 0x0b, 0x05, 0, 0, // structure_type: name string, byte_size data2
    4, 0x0d, 0, 0x03, 0x08, 0x38, 0x0b, 0, 0, // member: name string, data_member_location data1
    0,
  ])
  const dies = [
    1,
    2, ...cstr('k_mutex'), 56,
    4, ...cstr('owner'), 16,
    4, ...cstr('obj_core'), 40,
    0,
    3, ...cstr('k_thread'), 0xb0, 0x03,
    4, ...cstr('base'), 0,
    0,
    0,
  ]
  // unit_length, version 4, debug_abbrev_offset 0, address_size 8
  const header = [0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 8]
  const info = new Uint8Array([...header, ...dies])
  new DataView(info.buffer).setUint32(0, info.length - 4, true)
  return elfWithSections({ '.debug_abbrev': abbrev, '.debug_info': info })
}

describe('dwarfStruct', () => {
  it('reads a struct size alongside its member offsets', () => {
    const elf = zephyrDwarf()
    expect(dwarfStruct(elf, 'k_mutex')).toEqual({ size: 56, members: { owner: 16, obj_core: 40 } })
    expect(dwarfStruct(elf, 'k_thread')).toEqual({ size: 944, members: { base: 0 } })
    expect(dwarfStructMembers(elf, 'k_mutex')).toEqual({ owner: 16, obj_core: 40 })
  })

  it('has nothing for a struct the image does not describe', () => {
    const elf = zephyrDwarf()
    expect(dwarfStruct(elf, 'k_sem')).toBeNull()
    expect(dwarfStructMembers(elf, 'k_sem')).toEqual({})
  })
})
