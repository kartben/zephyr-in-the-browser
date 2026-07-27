/**
 * Function symbols from an unstripped Zephyr ELF — for PC labels and
 * breakpoint pickers. No DWARF; just .symtab STT_FUNC entries.
 */

export interface ElfSymbol {
  name: string
  addr: number
  size: number
}

export interface SymbolIndex {
  /** Sorted by address ascending. */
  byAddr: ElfSymbol[]
  /** Sorted by name for the picker. */
  byName: ElfSymbol[]
}

export interface ResolvedSymbol {
  name: string
  addr: number
  /** Bytes past the symbol start. */
  offset: number
}

const STT_FUNC = 2
const STT_GNU_IFUNC = 10

function parseSymtab(data: Uint8Array): ElfSymbol[] | null {
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

  const out: ElfSymbol[] = []
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
      if (type !== STT_FUNC && type !== STT_GNU_IFUNC) continue
      if (shndx === 0 || value === 0) continue // UND / null

      let end = nameOff
      while (end < strtab.length && strtab[end] !== 0) end++
      const name = decoder.decode(strtab.subarray(nameOff, end))
      if (!name || !isUsefulSymbol(name)) continue
      out.push({ name, addr: value, size: size || 0 })
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
  const byAddr = [...syms].sort((a, b) => a.addr - b.addr || a.name.localeCompare(b.name))
  const byName = [...syms].sort((a, b) => a.name.localeCompare(b.name) || a.addr - b.addr)
  return { byAddr, byName }
}

/** Nearest enclosing function symbol for an address. */
export function resolveSymbol(index: SymbolIndex | null, addr: number): ResolvedSymbol | null {
  if (!index || !Number.isFinite(addr)) return null
  const list = index.byAddr
  let lo = 0
  let hi = list.length - 1
  let best: ElfSymbol | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = list[mid]!
    if (s.addr <= addr) {
      best = s
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!best) return null
  const offset = addr - best.addr
  // If size is known, require addr inside the function; otherwise allow up to
  // the next symbol (or 64 KiB) so zero-size entries still resolve.
  if (best.size > 0) {
    if (offset >= best.size) return null
  } else {
    const idx = list.indexOf(best)
    const next = list[idx + 1]
    const span = next ? next.addr - best.addr : 0x10000
    if (offset >= span) return null
  }
  return { name: best.name, addr: best.addr, offset }
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
