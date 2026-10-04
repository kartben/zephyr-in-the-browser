import { describe, expect, it } from 'vitest'
import {
  buildElfDataSymbols,
  buildSymbolIndex,
  elfDataSymbolList,
  filterSymbols,
  formatSymbol,
  resolveDataSymbol,
  resolveSymbol,
} from '@/debug/elfSymbols'

const STT_NOTYPE = 0
const STT_OBJECT = 1
const STT_FUNC = 2
const SHN_ABS = 0xfff1
const EM_ARM = 40
const EM_XTENSA = 94

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

/**
 * Minimal ELF32 little-endian, the shape of the Cortex-M and RISC-V images, with
 * a section index per symbol so absolute (SHN_ABS) ones can be built too. An Arm
 * image unless `machine` says otherwise. `sections` become section headers 1, 2
 * and so on, so a symbol's `shndx` names one as in a real image: each has an
 * address and a size but no bytes, and is allocated unless `flags` says not.
 */
function fakeElf32(
  syms: { name: string; value: number; size: number; type: number; shndx: number }[],
  machine = EM_ARM,
  sections: { addr: number; size: number; flags?: number }[] = [],
): Uint8Array {
  let str = '\0'
  const nameOffs = syms.map((s) => {
    const off = str.length
    str += s.name + '\0'
    return off
  })
  const strtab = new TextEncoder().encode(str)

  const symEnt = 16
  const symtab = new Uint8Array((1 + syms.length) * symEnt) // null + syms
  const sv = new DataView(symtab.buffer)
  syms.forEach((s, i) => {
    const o = (i + 1) * symEnt
    sv.setUint32(o, nameOffs[i]!, true) // st_name
    sv.setUint32(o + 4, s.value, true) // st_value
    sv.setUint32(o + 8, s.size, true) // st_size
    symtab[o + 12] = 0x10 | s.type // st_info: STB_GLOBAL
    sv.setUint16(o + 14, s.shndx, true) // st_shndx
  })

  // Layout: Ehdr | Shdr[0 null] | Shdr[sections] | Shdr symtab | Shdr strtab | symtab | strtab
  const shoff = 52
  const shentsize = 40
  const symndx = 1 + sections.length
  const symoff = shoff + (symndx + 2) * shentsize
  const stroff = symoff + symtab.length
  const buf = new Uint8Array(stroff + strtab.length)
  const out = new DataView(buf.buffer)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]) // magic, ELFCLASS32, LSB, version
  out.setUint16(16, 2, true) // ET_EXEC
  out.setUint16(18, machine, true) // e_machine
  out.setUint32(32, shoff, true) // e_shoff
  out.setUint16(46, shentsize, true)
  out.setUint16(48, symndx + 2, true) // e_shnum

  sections.forEach((s, i) => {
    const sh = shoff + (i + 1) * shentsize
    out.setUint32(sh + 4, 1, true) // SHT_PROGBITS
    out.setUint32(sh + 8, s.flags ?? 0x2, true) // SHF_ALLOC
    out.setUint32(sh + 12, s.addr, true) // sh_addr
    out.setUint32(sh + 20, s.size, true) // sh_size
  })
  const shSym = shoff + symndx * shentsize
  out.setUint32(shSym + 4, 2, true) // SHT_SYMTAB
  out.setUint32(shSym + 16, symoff, true)
  out.setUint32(shSym + 20, symtab.length, true)
  out.setUint32(shSym + 24, symndx + 1, true) // link → strtab
  const shStr = shSym + shentsize
  out.setUint32(shStr + 4, 3, true) // SHT_STRTAB
  out.setUint32(shStr + 16, stroff, true)
  out.setUint32(shStr + 20, strtab.length, true)

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

  it('drops the absolute vfscanf at 0 that picolibc leaves on Cortex-M', () => {
    const elf = fakeElf32([
      // As in qemu_cortex_m3/dhcp.elf: with the Thumb bit dropped it would
      // span 0..0xe38, and a tour stop in main() would read "in vfscanf()".
      { name: 'vfscanf', value: 0x1, size: 3640, type: STT_FUNC, shndx: SHN_ABS },
      { name: 'main', value: 0xb4d, size: 116, type: STT_FUNC, shndx: 2 },
      // An ESP32-C3 ROM routine: absolute too, but real code.
      { name: 'memcpy', value: 0x4000_0358, size: 412, type: STT_FUNC, shndx: SHN_ABS },
      // Absolute data at 1: a Kconfig `y` and a linker-script value.
      {
        name: 'CONFIG_DT_HAS_TI_STELLARIS_GPIO_ENABLED',
        value: 1,
        size: 0,
        type: STT_OBJECT,
        shndx: SHN_ABS,
      },
      { name: '__tdata_align', value: 1, size: 0, type: STT_NOTYPE, shndx: SHN_ABS },
    ])
    const index = buildSymbolIndex(elf)!
    expect(index.byAddr.map((s) => s.name)).toEqual(['main', 'memcpy'])
    expect(filterSymbols(index, 'vfscanf')).toEqual([])
    expect(resolveSymbol(index, 0x40)).toBeNull()
    expect(formatSymbol(resolveSymbol(index, 0x4000_0360))).toBe('memcpy+0x8')

    expect(index.objects.get('CONFIG_DT_HAS_TI_STELLARIS_GPIO_ENABLED')?.addr).toBe(1)
    expect([...buildElfDataSymbols(elf).keys()]).toEqual([
      'CONFIG_DT_HAS_TI_STELLARIS_GPIO_ENABLED',
      '__tdata_align',
    ])
  })

  it('tells same-named statics apart by the file that defines them', () => {
    // st_info: STT_FILE = 4 and STT_OBJECT = 1 bind local; 0x11 is a global object.
    const elf = fakeElf([
      { name: 'fs.c', addr: 0, size: 0, type: 4 },
      { name: 'registry', addr: 0x40001000, size: 64, type: 1 },
      { name: 'kernel/obj_core.c', addr: 0, size: 0, type: 4 },
      { name: 'registry', addr: 0x40002000, size: 2048, type: 1 },
      { name: 'z_obj_type_list', addr: 0x40003000, size: 16, type: 0x11 },
    ])
    expect(elfDataSymbolList(elf)).toEqual([
      { name: 'registry', addr: 0x40001000, size: 64, type: 1, file: 'fs.c' },
      { name: 'registry', addr: 0x40002000, size: 2048, type: 1, file: 'obj_core.c' },
      { name: 'z_obj_type_list', addr: 0x40003000, size: 16, type: 1 },
    ])
    // The by-name index still keeps the first definition.
    expect(buildElfDataSymbols(elf).get('registry')?.addr).toBe(0x40001000)
  })

  describe('on Cortex-M, where every function symbol carries the Thumb bit', () => {
    // As in qemu_cortex_m3/basic_button.elf, where `nm` puts main at 0x270 and
    // the symtab says 0x271.
    const index = buildSymbolIndex(
      fakeElf32([
        { name: 'button_input_cb', value: 0x1e5, size: 0x8c, type: STT_FUNC, shndx: 2 },
        { name: 'main', value: 0x271, size: 0x20, type: STT_FUNC, shndx: 2 },
        { name: 'free_list_add', value: 0x291, size: 0x5c, type: STT_FUNC, shndx: 2 },
        // A bool in .bss: data has no Thumb bit, so odd is just where it is.
        { name: 'z_sys_post_kernel', value: 0x2000_081d, size: 1, type: STT_OBJECT, shndx: 3 },
      ]),
    )!

    it('names a function from an even PC at its entry', () => {
      // Compared raw, these were the last bytes of button_input_cb and main.
      expect(resolveSymbol(index, 0x270)).toEqual({ name: 'main', addr: 0x270, offset: 0 })
      expect(formatSymbol(resolveSymbol(index, 0x290))).toBe('free_list_add')
    })

    it('gives an even PC inside a function its exact offset', () => {
      expect(formatSymbol(resolveSymbol(index, 0x274))).toBe('main+0x4')
      expect(formatSymbol(resolveSymbol(index, 0x28e))).toBe('main+0x1e')
    })

    it('resolves an odd function pointer to the start of its function', () => {
      // A callback in a struct, as the Mem pane finds one: offset 0, and an
      // even start to report as its base.
      expect(resolveSymbol(index, 0x271)).toEqual({ name: 'main', addr: 0x270, offset: 0 })
    })

    it('lists functions at their first instruction, and leaves data alone', () => {
      expect(index.byName.find((s) => s.name === 'main')?.addr).toBe(0x270)
      expect(index.objects.get('z_sys_post_kernel')?.addr).toBe(0x2000_081d)
    })
  })

  it('takes nothing off an odd PC where there is no Thumb bit', () => {
    // Xtensa's 3-byte instructions leave PCs at odd addresses.
    const elf = fakeElf32(
      [{ name: 'blink', value: 0x400d_0f3c, size: 0x40, type: STT_FUNC, shndx: 2 }],
      EM_XTENSA,
    )
    expect(formatSymbol(resolveSymbol(buildSymbolIndex(elf), 0x400d_0f3f))).toBe('blink+0x3')
  })

  describe('a function the symtab gives no size', () => {
    // As in qemu_cortex_m3/basic_button.elf, where picolibc's vfprintf is a
    // size-0 alias of __l_vfprintf and the last function in `text`.
    const index = buildSymbolIndex(
      fakeElf32(
        [
          // Hand-written assembly with no `.size`.
          { name: 'z_arm_pendsv', value: 0xcf5, size: 0, type: STT_FUNC, shndx: 2 },
          { name: 'z_arm_interrupt_init', value: 0xd5d, size: 32, type: STT_FUNC, shndx: 2 },
          { name: '__l_vfprintf', value: 0x4251, size: 2498, type: STT_FUNC, shndx: 2 },
          { name: 'vfprintf', value: 0x4251, size: 0, type: STT_FUNC, shndx: 2 },
          { name: '__device_dts_ord_8', value: 0x4de0, size: 28, type: STT_OBJECT, shndx: 4 },
        ],
        EM_ARM,
        [
          { addr: 0x0, size: 0xec }, // rom_start
          { addr: 0xec, size: 0x4b28 }, // text
          { addr: 0x4c14, size: 0x98 }, // initlevel
          { addr: 0x4cac, size: 0x16c }, // device_area
          { addr: 0x4e18, size: 0x158 }, // sw_isr_table
          // Debug info: at no address, so its size is not a boundary.
          { addr: 0, size: 0x4500, flags: 0 },
        ],
      ),
    )!

    it('stops at the end of its section', () => {
      expect(formatSymbol(resolveSymbol(index, 0x4c10))).toBe('vfprintf+0x9c0')
      // A struct device pointer, which the call stack read as vfprintf+0xb90
      // and took for a return address.
      expect(resolveSymbol(index, 0x4de0)).toBeNull()
      expect(resolveSymbol(index, 0x4e18)).toBeNull()
    })

    it('still reaches to the next function inside its section', () => {
      expect(formatSymbol(resolveSymbol(index, 0xd40))).toBe('z_arm_pendsv+0x4c')
      expect(formatSymbol(resolveSymbol(index, 0xd5c))).toBe('z_arm_interrupt_init')
    })

    it('stops where the next section starts when it is in none', () => {
      // esp32_devkitc_esp32_procpu: libgcc's __muldf3 is an absolute ROM
      // address, and the next function is in IRAM, past the window and
      // interrupt vectors.
      const elf = fakeElf32(
        [
          { name: '__muldf3', value: 0x4006_358c, size: 0, type: STT_FUNC, shndx: SHN_ABS },
          { name: '__esp_platform_app_start', value: 0x4008_0bdc, size: 30, type: STT_FUNC, shndx: 2 },
        ],
        EM_XTENSA,
        [
          { addr: 0x4008_0000, size: 0x400 }, // .iram0.vectors
          { addr: 0x4008_0400, size: 0x9900 }, // .iram0.text
        ],
      )
      const rom = buildSymbolIndex(elf)!
      expect(formatSymbol(resolveSymbol(rom, 0x4006_3600))).toBe('__muldf3+0x74')
      // _WindowUnderflow4, which read __muldf3+0x1cab4.
      expect(resolveSymbol(rom, 0x4008_0040)).toBeNull()
      expect(formatSymbol(resolveSymbol(rom, 0x4008_0bdc))).toBe('__esp_platform_app_start')
    })
  })
})
