/**
 * Stack objects from an unstripped Zephyr ELF (.symtab STT_OBJECT).
 *
 * Host-only: match a thread's SP into a named stack buffer to get base + size
 * without requiring CONFIG_THREAD_STACK_INFO in the guest.
 */

export interface StackRegion {
  name: string
  addr: number
  size: number
}

const STT_OBJECT = 1
const SHN_UNDEF = 0

const MIN_STACK = 64
const MAX_STACK = 512 * 1024

function looksLikeStack(name: string): boolean {
  const n = name.toLowerCase()
  if (!n.includes('stack')) return false
  if (n.startsWith('$') || n.startsWith('.')) return false
  return true
}

/** Collect stack-like data objects from the ELF symbol table. */
export function buildStackRegions(elf: Uint8Array): StackRegion[] {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45) return []
  const elfclass = elf[4] as 1 | 2
  const little = elf[5] === 1
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
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
  const decoder = new TextDecoder()
  const out: StackRegion[] = []

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    if (u32(sh + 4) !== 2) continue // SHT_SYMTAB
    const shOffset = elfclass === 2 ? u64(sh + 24) : u32(sh + 16)
    const shSize = elfclass === 2 ? u64(sh + 32) : u32(sh + 20)
    const shLink = elfclass === 2 ? u32(sh + 40) : u32(sh + 24)
    const strSh = eShoff + shLink * eShentsize
    const strOff = elfclass === 2 ? u64(strSh + 24) : u32(strSh + 16)
    const strSize = elfclass === 2 ? u64(strSh + 32) : u32(strSh + 20)
    const strtab = elf.subarray(strOff, strOff + strSize)
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
        info = elf[eo + 4]!
        shndx = u16(eo + 6)
        value = u64(eo + 8)
        size = u64(eo + 16)
      } else {
        nameOff = u32(eo)
        value = u32(eo + 4)
        size = u32(eo + 8)
        info = elf[eo + 12]!
        shndx = u16(eo + 14)
      }
      if ((info & 0xf) !== STT_OBJECT) continue
      if (shndx === SHN_UNDEF || value === 0 || size < MIN_STACK || size > MAX_STACK) continue

      let end = nameOff
      while (end < strtab.length && strtab[end] !== 0) end++
      const name = decoder.decode(strtab.subarray(nameOff, end))
      if (!looksLikeStack(name)) continue
      out.push({ name, addr: value, size })
    }
  }

  // Tightest-fit matching prefers smaller regions first among equals.
  return out.sort((a, b) => a.size - b.size || a.addr - b.addr)
}

/**
 * Smallest stack region containing `sp` (downward-growing: base ≤ sp ≤ base+size).
 * Inclusive high bound — Zephyr's initial SP is often `start + size`.
 */
export function findStackRegion(regions: StackRegion[], sp: number): StackRegion | null {
  if (!sp) return null
  let best: StackRegion | null = null
  for (const r of regions) {
    if (sp >= r.addr && sp <= r.addr + r.size) {
      if (!best || r.size < best.size) best = r
    }
  }
  return best
}
