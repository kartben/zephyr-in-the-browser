/**
 * Zephyr CONFIG_DEBUG_THREAD_INFO — same ABI OpenOCD's Zephyr RTOS plugin uses.
 *
 * From an unstripped guest ELF we resolve:
 *   _kernel
 *   _kernel_thread_info_offsets
 *   _kernel_thread_info_num_offsets   (optional)
 *   _kernel_thread_info_size_t_size
 * then read the offset table out of the ELF's loadable image (same bytes the
 * guest has in ROM). Offset indices match subsys/debug/thread_info.c.
 */

export const UNIMPLEMENTED = 0xffffffff

export enum ThreadInfoOffset {
  VERSION = 0,
  K_CURR_THREAD = 1,
  K_THREADS = 2,
  T_ENTRY = 3,
  T_NEXT_THREAD = 4,
  T_STATE = 5,
  T_USER_OPTIONS = 6,
  T_PRIO = 7,
  T_STACK_PTR = 8,
  T_NAME = 9,
  T_ARCH = 10,
  T_PREEMPT_FLOAT = 11,
  T_COOP_FLOAT = 12,
  T_ARM_EXC_RETURN = 13,
  T_ARC_RELINQUISH_CAUSE = 14,
}

export interface ThreadInfo {
  /** Address of `_kernel`. */
  kernel: number
  ptrBytes: 4 | 8
  /** `_kernel_thread_info_offsets` values (size_t). */
  offsets: number[]
}

const NEED = [
  '_kernel',
  '_kernel_thread_info_offsets',
  '_kernel_thread_info_size_t_size',
] as const

type Loads = { vaddr: number; offset: number; filesz: number }[]

function parseElf(data: Uint8Array): {
  elfclass: 1 | 2
  little: boolean
  loads: Loads
  symbols: Map<string, number>
} | null {
  if (data.length < 64 || data[0] !== 0x7f || data[1] !== 0x45) return null
  const elfclass = data[4] as 1 | 2
  const little = data[5] === 1
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const u16 = (o: number) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false))
  const u32 = (o: number) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false))
  const u64 = (o: number) => {
    // Guest VAs fit in Number for our boards.
    const lo = u32(o)
    const hi = u32(o + 4)
    return little ? lo + hi * 0x1_0000_0000 : hi + lo * 0x1_0000_0000
  }

  let ePhoff: number
  let eShoff: number
  let ePhentsize: number
  let ePhnum: number
  let eShentsize: number
  let eShnum: number
  if (elfclass === 2) {
    ePhoff = u64(32)
    eShoff = u64(40)
    ePhentsize = u16(54)
    ePhnum = u16(56)
    eShentsize = u16(58)
    eShnum = u16(60)
  } else {
    ePhoff = u32(28)
    eShoff = u32(32)
    ePhentsize = u16(42)
    ePhnum = u16(44)
    eShentsize = u16(46)
    eShnum = u16(48)
  }

  const loads: Loads = []
  for (let i = 0; i < ePhnum; i++) {
    const off = ePhoff + i * ePhentsize
    if (elfclass === 2) {
      const pType = u32(off)
      if (pType !== 1) continue
      loads.push({ offset: u64(off + 8), vaddr: u64(off + 16), filesz: u64(off + 32) })
    } else {
      const pType = u32(off)
      if (pType !== 1) continue
      loads.push({ offset: u32(off + 4), vaddr: u32(off + 8), filesz: u32(off + 16) })
    }
  }

  const symbols = new Map<string, number>()
  const wanted = new Set<string>([...NEED, '_kernel_thread_info_num_offsets'])

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    const shType = elfclass === 2 ? u32(sh + 4) : u32(sh + 4)
    if (shType !== 2 && shType !== 11) continue // SYMTAB / DYNSYM
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
      if (elfclass === 2) {
        nameOff = u32(eo)
        value = u64(eo + 8)
      } else {
        nameOff = u32(eo)
        value = u32(eo + 4)
      }
      let end = nameOff
      while (end < strtab.length && strtab[end] !== 0) end++
      const name = new TextDecoder().decode(strtab.subarray(nameOff, end))
      if (wanted.has(name)) symbols.set(name, value)
    }
  }

  return { elfclass, little, loads, symbols }
}

function vmaToOffset(loads: Loads, addr: number): number | null {
  for (const seg of loads) {
    if (addr >= seg.vaddr && addr < seg.vaddr + seg.filesz) {
      return seg.offset + (addr - seg.vaddr)
    }
  }
  return null
}

function readSizeT(data: Uint8Array, fileOff: number, size: number, little: boolean): number {
  let n = 0
  for (let i = 0; i < size; i++) {
    const b = data[fileOff + i] ?? 0
    n += little ? b * 256 ** i : b * 256 ** (size - 1 - i)
  }
  return n
}

/**
 * Resolve CONFIG_DEBUG_THREAD_INFO from an unstripped Zephyr ELF.
 * Returns null when symbols are missing (stripped image, or Kconfig off).
 */
export function parseThreadInfoFromElf(elf: Uint8Array): ThreadInfo | null {
  const parsed = parseElf(elf)
  if (!parsed) return null
  const { elfclass, little, loads, symbols } = parsed
  for (const name of NEED) {
    if (!symbols.has(name)) return null
  }

  let sizeT = elfclass === 2 ? 8 : 4
  const sizeOff = vmaToOffset(loads, symbols.get('_kernel_thread_info_size_t_size')!)
  if (sizeOff !== null) sizeT = elf[sizeOff] ?? sizeT
  if (sizeT !== 4 && sizeT !== 8) return null

  let count = 15
  const numAddr = symbols.get('_kernel_thread_info_num_offsets')
  if (numAddr !== undefined) {
    const numOff = vmaToOffset(loads, numAddr)
    if (numOff !== null) count = readSizeT(elf, numOff, sizeT, little)
  }

  const arrOff = vmaToOffset(loads, symbols.get('_kernel_thread_info_offsets')!)
  if (arrOff === null) return null

  const offsets: number[] = []
  for (let i = 0; i < count; i++) {
    const at = arrOff + i * sizeT
    if (at + sizeT > elf.length) break
    offsets.push(readSizeT(elf, at, sizeT, little) >>> 0)
  }
  if (offsets.length < 5) return null
  // offsets[VERSION] is the ABI version (currently 1), not a struct field.
  if (offsets[ThreadInfoOffset.VERSION]! > 1) return null

  return {
    kernel: symbols.get('_kernel')!,
    ptrBytes: elfclass === 2 ? 8 : 4,
    offsets,
  }
}

export function off(info: ThreadInfo, index: ThreadInfoOffset): number | null {
  const v = info.offsets[index]
  if (v === undefined || v === UNIMPLEMENTED) return null
  return v
}
