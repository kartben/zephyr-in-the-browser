import { describe, expect, it } from 'vitest'
import {
  buildSymbolIndex,
  filterSymbols,
  formatSymbol,
  resolveDataSymbol,
  resolveSymbol,
} from '@/debug/elfSymbols'

/** Minimal ELF64 little-endian with one SHT_SYMTAB FUNC symbol. */
function fakeElf(syms: { name: string; addr: number; size: number; type?: number }[]): Uint8Array {
  const encoder = new TextEncoder()
  const names = ['', ...syms.map((s) => s.name)]
  let str = ''
  const offs: number[] = []
  for (const n of names) {
    offs.push(str.length)
    str += n + '\0'
  }
  const strtab = encoder.encode(str)

  const symEnt = 24
  const symtab = new Uint8Array((1 + syms.length) * symEnt) // null + syms
  const dv = new DataView(symtab.buffer)
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i]!
    const o = (i + 1) * symEnt
    dv.setUint32(o, offs[i + 1]!, true) // st_name
    symtab[o + 4] = s.type ?? 2 // STT_FUNC
    dv.setUint16(o + 6, 1, true) // st_shndx = 1
    // st_value
    dv.setUint32(o + 8, s.addr >>> 0, true)
    dv.setUint32(o + 12, 0, true)
    dv.setUint32(o + 16, s.size >>> 0, true)
    dv.setUint32(o + 20, 0, true)
  }

  // Layout: Ehdr | Shdr[0 null] | Shdr[1 symtab] | Shdr[2 strtab] | symtab | strtab
  const ehdrSize = 64
  const shentsize = 64
  const shnum = 3
  const shoff = ehdrSize
  const symoff = shoff + shnum * shentsize
  const stroff = symoff + symtab.length
  const total = stroff + strtab.length
  const buf = new Uint8Array(total)
  const out = new DataView(buf.buffer)

  const setU64 = (o: number, v: number) => {
    out.setUint32(o, v >>> 0, true)
    out.setUint32(o + 4, Math.floor(v / 0x1_0000_0000), true)
  }

  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2 // ELFCLASS64
  buf[5] = 1 // ELFDATA2LSB
  buf[6] = 1
  out.setUint16(16, 2, true) // ET_EXEC
  out.setUint16(18, 0xb7, true) // EM_AARCH64
  out.setUint32(20, 1, true)
  setU64(32, 0) // phoff
  setU64(40, shoff)
  out.setUint16(54, 0, true) // phentsize
  out.setUint16(56, 0, true)
  out.setUint16(58, shentsize, true)
  out.setUint16(60, shnum, true)
  out.setUint16(62, 2, true) // shstrndx unused

  // shdr 1 = symtab
  const sh1 = shoff + shentsize
  out.setUint32(sh1 + 4, 2, true) // SHT_SYMTAB
  setU64(sh1 + 24, symoff)
  setU64(sh1 + 32, symtab.length)
  out.setUint32(sh1 + 40, 2, true) // link → strtab

  // shdr 2 = strtab
  const sh2 = shoff + 2 * shentsize
  out.setUint32(sh2 + 4, 3, true) // SHT_STRTAB
  setU64(sh2 + 24, stroff)
  setU64(sh2 + 32, strtab.length)

  buf.set(symtab, symoff)
  buf.set(strtab, stroff)
  return buf
}

describe('elfSymbols', () => {
  it('resolves addresses to function+offset', () => {
    const elf = fakeElf([
      { name: 'shell_process', addr: 0x40010000, size: 0x100 },
      { name: 'main', addr: 0x40011000, size: 0x40 },
    ])
    const index = buildSymbolIndex(elf)!
    expect(resolveSymbol(index, 0x40010000)).toEqual({
      name: 'shell_process',
      addr: 0x40010000,
      offset: 0,
    })
    expect(formatSymbol(resolveSymbol(index, 0x40010014))).toBe('shell_process+0x14')
    expect(resolveSymbol(index, 0x40011010)?.name).toBe('main')
    expect(resolveSymbol(index, 0x40012000)).toBeNull()
  })

  it('resolves addresses inside data objects to object+offset', () => {
    const STT_OBJECT = 1
    const elf = fakeElf([
      { name: 'main', addr: 0x40011000, size: 0x40 },
      { name: 'z_interrupt_stacks', addr: 0x40100000, size: 0x2000, type: STT_OBJECT },
      // What real images carry with no size: absolute constants, empty structs.
      { name: 'CONFIG_SRAM_BASE_ADDRESS', addr: 0x40100000, size: 0, type: STT_OBJECT },
      { name: 'sem_lock', addr: 0x40102000, size: 0, type: STT_OBJECT },
    ])
    const index = buildSymbolIndex(elf)!
    // A stack pointer in the interrupt stack, the case that showed a bare hex.
    expect(formatSymbol(resolveDataSymbol(index, 0x40101f80))).toBe('z_interrupt_stacks+0x1f80')
    // An object with no size occupies nothing, so it never names an address.
    expect(formatSymbol(resolveDataSymbol(index, 0x40100000))).toBe('z_interrupt_stacks')
    expect(resolveDataSymbol(index, 0x40102000)).toBeNull()
    expect(resolveDataSymbol(index, 0x40011010)).toBeNull()
    // Functions-only stays functions-only: PC labels and the unwinder rely on it.
    expect(resolveSymbol(index, 0x40101f80)).toBeNull()
  })

  it('filters picker suggestions', () => {
    const elf = fakeElf([
      { name: 'shell_process', addr: 0x1, size: 4 },
      { name: 'shell_execute', addr: 0x2, size: 4 },
      { name: 'main', addr: 0x3, size: 4 },
      { name: '$d', addr: 0x4, size: 4 },
    ])
    const index = buildSymbolIndex(elf)!
    expect(index.byName.map((s) => s.name)).not.toContain('$d')
    expect(filterSymbols(index, 'shell').map((s) => s.name)).toEqual([
      'shell_execute',
      'shell_process',
    ])
  })
})
