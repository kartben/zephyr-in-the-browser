/**
 * ELF section lookup, shared by everything that reads DWARF out of the guest
 * image. Class-agnostic (32- and 64-bit) and endian-agnostic, because the page
 * boots Cortex-M3, Cortex-A53 and RISC-V images from the same code.
 */

export interface ElfSection {
  offset: number
  size: number
}

/** Find a section by name, or null when the image has none (a stripped ELF). */
export function findSection(data: Uint8Array, name: string): ElfSection | null {
  if (data.length < 64 || data[0] !== 0x7f) return null
  const elfclass = data[4] as 1 | 2
  const little = data[5] === 1
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
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
    if (dec.decode(shstr.subarray(nameOff, end)) !== name) continue
    return {
      offset: elfclass === 2 ? u64(sh + 24) : u32(sh + 16),
      size: elfclass === 2 ? u64(sh + 32) : u32(sh + 20),
    }
  }
  return null
}

/** True for a 64-bit ELF — the pointer width `*` follows in a tour expression. */
export function elfPointerBytes(data: Uint8Array): 4 | 8 {
  return data.length > 4 && data[4] === 2 ? 8 : 4
}
