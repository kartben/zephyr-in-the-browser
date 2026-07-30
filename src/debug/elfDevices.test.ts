import { describe, expect, it } from 'vitest'
import { deviceLabel, readElfDeviceNames } from './elfDevices'
import { readElfCString, readElfVirtual } from './elfSymbols'

/*
 * A minimal but real ELF64 little-endian image: one SHF_ALLOC PROGBITS section
 * holding two `struct device` heads and their name strings, plus a .symtab and
 * .strtab. Hand-built rather than checked in as a binary fixture so the layout
 * being asserted is visible, and so no build artifact is needed to run it.
 */

const BASE = 0x4000_0000
const SEC_OFF = 0x200
/** Offsets within the data section: two device structs, then the strings. */
const DEV_A = 0x00
const DEV_B = 0x40
const STR_A = 0x80
const STR_B = 0x90
const DEPS_BOUND = 0xa0
const SEC_SIZE = 0xc0

interface Sym {
  name: string
  addr: number
  /** STT_OBJECT (1) or STT_NOTYPE (0). */
  type: number
}

function buildElf(syms: Sym[]): Uint8Array {
  const data = new Uint8Array(SEC_SIZE)
  const dv = new DataView(data.buffer)
  const enc = new TextEncoder()

  // struct device { const char *name; ... } — name at offset 0 is the contract.
  dv.setBigUint64(DEV_A, BigInt(BASE + STR_A), true)
  dv.setBigUint64(DEV_B, BigInt(BASE + STR_B), true)
  data.set(enc.encode('pm-demo-radio\0'), STR_A)
  data.set(enc.encode('uart@9000000\0'), STR_B)
  // Whatever happens to sit at a linker bound: not a pointer to a string.
  dv.setBigUint64(DEPS_BOUND, 0x0000_1003_4000_0000n, true)

  const strtabParts = ['\0', ...syms.map((s) => `${s.name}\0`)]
  const nameOffsets: number[] = []
  let acc = 1
  for (const s of syms) {
    nameOffsets.push(acc)
    acc += s.name.length + 1
  }
  const strtab = enc.encode(strtabParts.join(''))

  const symtab = new Uint8Array((syms.length + 1) * 24)
  const sv = new DataView(symtab.buffer)
  syms.forEach((s, i) => {
    const o = (i + 1) * 24
    sv.setUint32(o, nameOffsets[i], true)
    symtab[o + 4] = s.type // info: bind 0, type in low nibble
    sv.setUint16(o + 6, 1, true) // shndx: the data section
    sv.setBigUint64(o + 8, BigInt(s.addr), true)
    sv.setBigUint64(o + 16, 8n, true) // size
  })

  const SYMTAB_OFF = SEC_OFF + SEC_SIZE
  const STRTAB_OFF = SYMTAB_OFF + symtab.length
  const SHOFF = STRTAB_OFF + strtab.length
  const total = SHOFF + 4 * 64

  const elf = new Uint8Array(total)
  const ev = new DataView(elf.buffer)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0) // magic, ELF64, LSB, version
  ev.setUint16(16, 2, true) // e_type ET_EXEC
  ev.setBigUint64(40, BigInt(SHOFF), true) // e_shoff
  ev.setUint16(58, 64, true) // e_shentsize
  ev.setUint16(60, 4, true) // e_shnum

  elf.set(data, SEC_OFF)
  elf.set(symtab, SYMTAB_OFF)
  elf.set(strtab, STRTAB_OFF)

  const section = (
    i: number,
    type: number,
    flags: number,
    addr: number,
    offset: number,
    size: number,
    link = 0,
  ) => {
    const sh = SHOFF + i * 64
    ev.setUint32(sh + 4, type, true)
    ev.setBigUint64(sh + 8, BigInt(flags), true)
    ev.setBigUint64(sh + 16, BigInt(addr), true)
    ev.setBigUint64(sh + 24, BigInt(offset), true)
    ev.setBigUint64(sh + 32, BigInt(size), true)
    ev.setUint32(sh + 40, link, true)
  }
  section(0, 0, 0, 0, 0, 0) // SHT_NULL
  section(1, 1, 0x2, BASE, SEC_OFF, SEC_SIZE) // PROGBITS + SHF_ALLOC
  section(2, 2, 0, 0, SYMTAB_OFF, symtab.length, 3) // SYMTAB -> strtab
  section(3, 3, 0, 0, STRTAB_OFF, strtab.length) // STRTAB
  return elf
}

const ELF = buildElf([
  { name: '__device_dts_ord_4', addr: BASE + DEV_A, type: 1 },
  { name: '__device_dts_ord_20', addr: BASE + DEV_B, type: 1 },
  // Linker section bounds share the prefix and are not devices.
  { name: '__device_deps_start', addr: BASE + DEPS_BOUND, type: 0 },
  { name: '__device_deps_end', addr: BASE + DEPS_BOUND, type: 0 },
  { name: 'main', addr: BASE + DEV_A, type: 1 },
])

describe('readElfVirtual', () => {
  it('translates a virtual address into section bytes', () => {
    expect(readElfCString(ELF, BASE + STR_A)).toBe('pm-demo-radio')
    expect(readElfCString(ELF, BASE + STR_B)).toBe('uart@9000000')
  })

  it('returns null outside any allocated section', () => {
    expect(readElfVirtual(ELF, 0x1000_0000, 4)).toBeNull()
    expect(readElfVirtual(ELF, BASE + SEC_SIZE + 8, 4)).toBeNull()
    expect(readElfCString(ELF, 0xdead_beef)).toBeNull()
  })

  it('clamps a read at the section boundary instead of failing', () => {
    const bytes = readElfVirtual(ELF, BASE + SEC_SIZE - 4, 64)
    expect(bytes).not.toBeNull()
    expect(bytes).toHaveLength(4)
  })

  it('rejects a non-ELF buffer rather than reading nonsense', () => {
    expect(readElfVirtual(new Uint8Array(128), BASE, 4)).toBeNull()
  })
})

describe('readElfDeviceNames', () => {
  it('follows the name pointer at offset 0 of each device struct', () => {
    const names = readElfDeviceNames(ELF)
    expect(names.byAddr.get(BASE + DEV_A)).toBe('pm-demo-radio')
    expect(names.byAddr.get(BASE + DEV_B)).toBe('uart@9000000')
  })

  it('skips linker section bounds that share the __device_ prefix', () => {
    const names = readElfDeviceNames(ELF)
    expect(names.byAddr.has(BASE + DEPS_BOUND)).toBe(false)
    expect(names.byAddr.size).toBe(2)
  })

  it('ignores symbols without the prefix', () => {
    // `main` points at a real device struct here, so only the name filter keeps
    // it out — which is the behaviour worth pinning.
    const names = readElfDeviceNames(ELF)
    expect([...names.byAddr.values()]).not.toContain('main')
  })

  it('keys on the low 32 bits, which is what the guest emits', () => {
    // ctf_top.c casts through (uint32_t)(uintptr_t), so the trace carries the
    // truncation and lookups have to match it.
    const names = readElfDeviceNames(ELF)
    expect(deviceLabel(names, (BASE + DEV_A) >>> 0)).toBe('pm-demo-radio')
  })

  it('falls back to hex for a pointer it cannot name', () => {
    expect(deviceLabel(readElfDeviceNames(ELF), 0x4000_9999)).toBe('0x40009999')
    expect(deviceLabel(null, 0x4000_9999)).toBe('0x40009999')
  })
})
