import { describe, expect, it } from 'vitest'
import { buildStackRegions, findStackRegion } from '@/debug/elfStacks'

/** Minimal ELF64 LE with STT_OBJECT symbols (same layout as elfSymbols.test). */
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
  const symtab = new Uint8Array((1 + syms.length) * symEnt)
  const dv = new DataView(symtab.buffer)
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i]!
    const o = (i + 1) * symEnt
    dv.setUint32(o, offs[i + 1]!, true)
    symtab[o + 4] = s.type ?? 1 // STT_OBJECT
    dv.setUint16(o + 6, 1, true)
    dv.setUint32(o + 8, s.addr >>> 0, true)
    dv.setUint32(o + 12, 0, true)
    dv.setUint32(o + 16, s.size >>> 0, true)
    dv.setUint32(o + 20, 0, true)
  }

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
  buf[4] = 2
  buf[5] = 1
  buf[6] = 1
  out.setUint16(16, 2, true)
  out.setUint16(18, 0xb7, true)
  out.setUint32(20, 1, true)
  setU64(40, shoff)
  out.setUint16(58, shentsize, true)
  out.setUint16(60, shnum, true)
  out.setUint16(62, 2, true)

  const sh1 = shoff + shentsize
  out.setUint32(sh1 + 4, 2, true)
  setU64(sh1 + 24, symoff)
  setU64(sh1 + 32, symtab.length)
  out.setUint32(sh1 + 40, 2, true)

  const sh2 = shoff + 2 * shentsize
  out.setUint32(sh2 + 4, 3, true)
  setU64(sh2 + 24, stroff)
  setU64(sh2 + 32, strtab.length)

  buf.set(symtab, symoff)
  buf.set(strtab, stroff)
  return buf
}

describe('elfStacks', () => {
  it('collects stack-named OBJECT symbols', () => {
    const elf = fakeElf([
      { name: 'main_stack', addr: 0x20001000, size: 2048 },
      { name: 'shell_stack', addr: 0x20002000, size: 1024 },
      { name: 'not_a_buffer', addr: 0x20003000, size: 4096 }, // no "stack" in name
      { name: 'tiny_stack', addr: 0x20004000, size: 16 }, // too small
    ])
    const regions = buildStackRegions(elf)
    expect(regions.map((r) => r.name).sort()).toEqual(['main_stack', 'shell_stack'])
  })

  it('finds the tightest region for an SP', () => {
    const regions = buildStackRegions(
      fakeElf([
        { name: 'outer_stack', addr: 0x20000000, size: 8192 },
        { name: 'inner_stack', addr: 0x20001000, size: 2048 },
      ]),
    )
    expect(findStackRegion(regions, 0x20001800)?.name).toBe('inner_stack')
  })
})
