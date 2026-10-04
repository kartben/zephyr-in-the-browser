/**
 * Symbols from an unstripped Zephyr ELF — functions for PC labels and
 * breakpoint pickers, data symbols for tour expressions. No DWARF; just
 * .symtab.
 */

import { archFromElf, codeAddr, type GdbArch } from '@/debug/gdb/regs'

export interface ElfSymbol {
  name: string
  addr: number
  size: number
}

/** Defined ELF symbol with its raw STT_* type. */
export interface ElfTypedSymbol extends ElfSymbol {
  type: number
  /** Source file of a local (`static`) symbol, from the STT_FILE entry before it. */
  file?: string
}

export interface SymbolIndex {
  /** Functions, sorted by address ascending. */
  byAddr: ElfSymbol[]
  /** Functions, sorted by name for the picker. */
  byName: ElfSymbol[]
  /**
   * Data symbols (STT_OBJECT), by name. Kept apart from the function lists so
   * PC labels and the breakpoint picker stay functions-only; a tour watching
   * `led+8` needs them, and nothing else does.
   */
  objects: Map<string, ElfSymbol>
  /**
   * The machine the image is for, from its ELF header, when this page has a
   * decoder for it. On 'arm' (Cortex-M) the symtab sets bit 0 of every
   * function's value to say Thumb, and that bit is not part of the address. The
   * function lists above leave it off, and {@link resolveSymbol} takes it off
   * the address it is asked about too. Data symbols keep their values.
   */
  arch?: GdbArch | null
  /**
   * Where each section that takes up address space starts and ends, ascending:
   * the fences a function with no size cannot reach across. See
   * {@link resolveSymbol}.
   */
  sectionBounds?: number[]
}

export interface ResolvedSymbol {
  name: string
  /** Where the function starts: on Cortex-M, without the Thumb bit. */
  addr: number
  /** Bytes past the symbol start. */
  offset: number
}

const STT_OBJECT = 1
const STT_FUNC = 2
const STT_FILE = 4
const STT_GNU_IFUNC = 10
const SHN_ABS = 0xfff1
const STB_LOCAL = 0

function parseSymtab(data: Uint8Array): ElfTypedSymbol[] | null {
  if (data.length < 64 || data[0] !== 0x7f || data[1] !== 0x45) return null
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

  const out: ElfTypedSymbol[] = []
  const decoder = new TextDecoder()

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    const shType = u32(sh + 4)
    if (shType !== 2) continue // SHT_SYMTAB only (not dynsym — baremetal)
    const shOffset = elfclass === 2 ? u64(sh + 24) : u32(sh + 16)
    const shSize = elfclass === 2 ? u64(sh + 32) : u32(sh + 20)
    const shLink = elfclass === 2 ? u32(sh + 40) : u32(sh + 24)
    const strSh = eShoff + shLink * eShentsize
    const strOff = elfclass === 2 ? u64(strSh + 24) : u32(strSh + 16)
    const strSize = elfclass === 2 ? u64(strSh + 32) : u32(strSh + 20)
    const strtab = data.subarray(strOff, strOff + strSize)
    const ent = elfclass === 2 ? 24 : 16
    const nameAt = (off: number) => {
      let end = off
      while (end < strtab.length && strtab[end] !== 0) end++
      return decoder.decode(strtab.subarray(off, end))
    }
    // Locals follow the STT_FILE entry of the file that defined them.
    let file: string | undefined

    for (let j = 0; j < shSize; j += ent) {
      const eo = shOffset + j
      let nameOff: number
      let value: number
      let size: number
      let info: number
      let shndx: number
      if (elfclass === 2) {
        nameOff = u32(eo)
        info = data[eo + 4]!
        shndx = u16(eo + 6)
        value = u64(eo + 8)
        size = u64(eo + 16)
      } else {
        nameOff = u32(eo)
        value = u32(eo + 4)
        size = u32(eo + 8)
        info = data[eo + 12]!
        shndx = u16(eo + 14)
      }
      const type = info & 0xf
      if (type === STT_FILE) {
        file = nameAt(nameOff).split('/').pop() || undefined
        continue
      }
      if (
        type !== STT_OBJECT &&
        type !== STT_FUNC &&
        type !== STT_GNU_IFUNC &&
        type !== 0 // STT_NOTYPE — linker-defined section bounds
      ) {
        continue
      }
      if (shndx === 0 || value === 0) continue // UND / null
      // An absolute function is code only where it names a real address, as
      // the ESP32 ROM routines do. Picolibc leaves one at 0, `vfscanf`, which
      // the check above drops everywhere but Cortex-M: there the Thumb bit
      // makes it 1, and it would label the start of flash and sit in the
      // breakpoint picker. Absolute data (CONFIG_*, generated offsets) stays.
      if (shndx === SHN_ABS && value === 1 && (type === STT_FUNC || type === STT_GNU_IFUNC)) {
        continue
      }

      const name = nameAt(nameOff)
      if (!name || !isUsefulSymbol(name)) continue
      const local = info >> 4 === STB_LOCAL
      out.push({ name, addr: value, size: size || 0, type, ...(local && file ? { file } : {}) })
    }
  }
  return out
}

/** Drop compiler / toolchain noise from the picker. */
function isUsefulSymbol(name: string): boolean {
  if (name.startsWith('$') || name.startsWith('.')) return false
  if (name.startsWith('__')) {
    // Keep a few Zephyr/runtime hooks people actually break on.
    if (
      name === '__start' ||
      name.startsWith('__aeabi_') ||
      name.startsWith('__thumb')
    ) {
      return false
    }
  }
  return true
}

export function buildSymbolIndex(elf: Uint8Array): SymbolIndex | null {
  const syms = parseSymtab(elf)
  if (!syms || syms.length === 0) return null
  const arch = archFromElf(elf)
  // Each function at the address of its first instruction, which on Cortex-M
  // is not the symtab's value: `main` at 0x270 is listed as 0x271.
  const functions = syms
    .filter((s) => s.type === STT_FUNC || s.type === STT_GNU_IFUNC)
    .map((s) => (arch ? { ...s, addr: codeAddr(arch, s.addr) } : s))
  const byAddr = [...functions].sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name))
  const byName = [...functions].sort((a, b) => a.name.localeCompare(b.name) || a.addr - b.addr)
  const objects = new Map<string, ElfSymbol>()
  for (const s of syms) {
    // Statics repeat across translation units; first one wins, which is the
    // lowest address and so the one a tour written against the sample means.
    if (s.type === STT_OBJECT && !objects.has(s.name)) {
      objects.set(s.name, { name: s.name, addr: s.addr, size: s.size })
    }
  }
  return { byAddr, byName, objects, arch, sectionBounds: sectionBounds(elf) }
}

/** Start and end of every section that takes up address space, ascending. */
function sectionBounds(elf: Uint8Array): number[] {
  const elfclass = elf[4] as 1 | 2
  const little = elf[5] === 1
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
  const u16 = (o: number) => dv.getUint16(o, little)
  const u32 = (o: number) => dv.getUint32(o, little)
  const u64 = (o: number) => {
    const lo = u32(o)
    const hi = u32(o + 4)
    return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
  }

  const eShoff = elfclass === 2 ? u64(40) : u32(32)
  const eShentsize = elfclass === 2 ? u16(58) : u16(46)
  const eShnum = elfclass === 2 ? u16(60) : u16(48)

  const bounds = new Set<number>()
  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    const shFlags = elfclass === 2 ? u64(sh + 8) : u32(sh + 8)
    const shAddr = elfclass === 2 ? u64(sh + 16) : u32(sh + 12)
    const shSize = elfclass === 2 ? u64(sh + 32) : u32(sh + 20)
    if ((shFlags & 0x2) === 0 || shSize === 0) continue // not SHF_ALLOC, or empty
    bounds.add(shAddr)
    bounds.add(shAddr + shSize)
  }
  return [...bounds].sort((a, b) => a - b)
}

/** The first bound past `addr`, or Infinity past the last one. */
function boundAfter(bounds: readonly number[] | undefined, addr: number): number {
  if (!bounds) return Infinity
  let lo = 0
  let hi = bounds.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bounds[mid]! <= addr) lo = mid + 1
    else hi = mid
  }
  return bounds[lo] ?? Infinity
}

/**
 * Read bytes at a *virtual* address straight out of the ELF image.
 *
 * The point is to answer questions about ROM contents without a live target: an
 * unstripped image already holds every `const` the guest will ever see, at the
 * addresses it will see them, so anything in .rodata can be read offline —
 * before the machine boots, and with the debugger detached.
 *
 * Returns null for an address in no loaded section, or in .bss (SHT_NOBITS has
 * no bytes in the file, only a size), which is the honest answer: that memory
 * only exists at runtime.
 */
export function readElfVirtual(elf: Uint8Array, addr: number, length: number): Uint8Array | null {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45) return null
  if (!Number.isFinite(addr) || length <= 0) return null
  const elfclass = elf[4] as 1 | 2
  const little = elf[5] === 1
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
  const u16 = (o: number) => dv.getUint16(o, little)
  const u32 = (o: number) => dv.getUint32(o, little)
  const u64 = (o: number) => {
    const lo = u32(o)
    const hi = u32(o + 4)
    return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
  }

  const eShoff = elfclass === 2 ? u64(40) : u32(32)
  const eShentsize = elfclass === 2 ? u16(58) : u16(46)
  const eShnum = elfclass === 2 ? u16(60) : u16(48)

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    const shType = u32(sh + 4)
    if (shType === 0 || shType === 8) continue // SHT_NULL / SHT_NOBITS (.bss)
    const shFlags = elfclass === 2 ? u64(sh + 8) : u32(sh + 8)
    if ((shFlags & 0x2) === 0) continue // not SHF_ALLOC: not in the address space
    const shAddr = elfclass === 2 ? u64(sh + 16) : u32(sh + 12)
    const shOffset = elfclass === 2 ? u64(sh + 24) : u32(sh + 16)
    const shSize = elfclass === 2 ? u64(sh + 32) : u32(sh + 20)
    if (shAddr === 0 || addr < shAddr || addr >= shAddr + shSize) continue
    const start = shOffset + (addr - shAddr)
    // Clamp rather than fail: a string near the end of a section is still
    // readable up to the section boundary.
    const end = Math.min(start + length, shOffset + shSize, elf.length)
    return end > start ? elf.subarray(start, end) : null
  }
  return null
}

/** A NUL-terminated C string at a virtual address, or null. */
export function readElfCString(elf: Uint8Array, addr: number, max = 64): string | null {
  const bytes = readElfVirtual(elf, addr, max)
  if (!bytes) return null
  let end = 0
  while (end < bytes.length && bytes[end] !== 0) end++
  if (end === 0) return null
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/**
 * All defined data and linker symbols. Unlike {@link buildSymbolIndex}, this
 * includes STT_NOTYPE section bounds such as `_k_obj_core_desc_list_start`.
 */
export function buildElfDataSymbols(elf: Uint8Array): Map<string, ElfTypedSymbol> {
  return dataSymbolsByName(elfDataSymbolList(elf))
}

/**
 * The same symbols as {@link buildElfDataSymbols}, in symbol-table order and
 * with every duplicate kept. A name like `registry` can be a `static` in
 * several files, and only each one's {@link ElfTypedSymbol.file} tells them
 * apart.
 */
export function elfDataSymbolList(elf: Uint8Array): ElfTypedSymbol[] {
  return (parseSymtab(elf) ?? []).filter((s) => s.type === STT_OBJECT || s.type === 0)
}

/** Index data symbols by name: the first wins, unless only a later one has a size. */
export function dataSymbolsByName(symbols: readonly ElfTypedSymbol[]): Map<string, ElfTypedSymbol> {
  const out = new Map<string, ElfTypedSymbol>()
  for (const s of symbols) {
    const old = out.get(s.name)
    if (!old || (old.size === 0 && s.size > 0)) out.set(s.name, s)
  }
  return out
}

/**
 * Nearest enclosing function symbol for an address.
 *
 * The Thumb bit comes off `addr` as it came off the function list, so the even
 * PC gdb reports and the odd function pointer Cortex-M keeps in memory both
 * resolve to the instruction they point at.
 */
export function resolveSymbol(index: SymbolIndex | null, addr: number): ResolvedSymbol | null {
  if (!index || !Number.isFinite(addr)) return null
  const at = index.arch ? codeAddr(index.arch, addr) : addr
  const list = index.byAddr
  let lo = 0
  let hi = list.length - 1
  let best: ElfSymbol | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = list[mid]!
    if (s.addr <= at) {
      best = s
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!best) return null
  const offset = at - best.addr
  // A size says where the function ends. Without one (assembly with no `.size`,
  // or an alias such as picolibc's vfprintf) it runs to the next function, but
  // never across a section boundary. As the last function in `text`, vfprintf
  // would otherwise claim the device structs and rodata after it, and a pointer
  // to one of those on the stack would pass for a return address. A routine in
  // no section, like ESP32's absolute ROM `__muldf3`, stops at the next section.
  if (best.size > 0) {
    if (offset >= best.size) return null
  } else {
    const idx = list.indexOf(best)
    const next = list[idx + 1]
    const span = Math.min(
      next ? next.addr - best.addr : 0x10000,
      boundAfter(index.sectionBounds, best.addr) - best.addr,
    )
    if (offset >= span) return null
  }
  return { name: best.name, addr: best.addr, offset }
}

/**
 * The data object an address falls inside, so a pointer that is not code can
 * be named too: a stack pointer reads as `z_interrupt_stacks+0x7c0`.
 *
 * Separate from {@link resolveSymbol} on purpose, because PC labels and the
 * stack unwinder call that one and must keep getting functions only. Stricter
 * as well: only an object with a size names an address. A function with no
 * size reaches to the next symbol, but an object with none is nearly always a
 * number dressed as a symbol (`CONFIG_SRAM_BASE_ADDRESS`, a `___*_OFFSET`) or
 * an empty struct sharing its address with the variable that really lives
 * there, and naming an address after either would mislead.
 */
export function resolveDataSymbol(index: SymbolIndex | null, addr: number): ResolvedSymbol | null {
  if (!index || !Number.isFinite(addr)) return null
  let best: ElfSymbol | null = null
  for (const s of index.objects.values()) {
    if (s.size === 0 || addr < s.addr || addr >= s.addr + s.size) continue
    // Should two overlap (an alias, say), the tightest is the most specific.
    if (!best || s.size < best.size) best = s
  }
  return best ? { name: best.name, addr: best.addr, offset: addr - best.addr } : null
}

/** `foo` or `foo+0x14` — compact for chips and lists. */
export function formatSymbol(res: ResolvedSymbol | null): string | null {
  if (!res) return null
  if (res.offset === 0) return res.name
  return `${res.name}+0x${res.offset.toString(16)}`
}

/** Filter the name-sorted list for a typeahead (case-insensitive substring). */
export function filterSymbols(index: SymbolIndex | null, query: string, limit = 40): ElfSymbol[] {
  if (!index) return []
  const q = query.trim().toLowerCase()
  if (!q) {
    // Prefer a short "useful" default set: shell / main / z_ / k_
    const preferred = index.byName.filter((s) =>
      /^(main|shell|z_|k_|btn_|led_|uart_|i2c_|spi_)/i.test(s.name),
    )
    return (preferred.length > 0 ? preferred : index.byName).slice(0, limit)
  }
  const out: ElfSymbol[] = []
  for (const s of index.byName) {
    if (s.name.toLowerCase().includes(q)) {
      out.push(s)
      if (out.length >= limit) break
    }
  }
  return out
}
