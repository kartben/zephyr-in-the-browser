/**
 * Kernel sync / wait-queue objects from an unstripped Zephyr ELF.
 *
 * Host-only: when a thread is PENDING, `base.pended_on` points at a `_wait_q_t`
 * embedded in a k_sem / k_mutex / … — usually the object's first field, so the
 * pointer equals (or falls inside) a named STT_OBJECT symbol.
 */

export interface WaitObject {
  name: string
  addr: number
  size: number
  /** Best-effort kind from the symbol name. */
  kind: string | null
}

const STT_OBJECT = 1
const SHN_UNDEF = 0

const MIN_SIZE = 4
const MAX_SIZE = 64 * 1024

/** Name → kind for common Zephyr primitives (substring match, longer first). */
const KIND_HINTS: [string, string][] = [
  ['condvar', 'condvar'],
  ['msgq', 'msgq'],
  ['mutex', 'mutex'],
  ['mbox', 'mbox'],
  ['fifo', 'fifo'],
  ['lifo', 'lifo'],
  ['pipe', 'pipe'],
  ['poll', 'poll'],
  ['event', 'event'],
  ['queue', 'queue'],
  ['heap', 'heap'],
  ['slab', 'slab'],
  ['sem', 'sem'],
]

export function classifyWaitObject(name: string): string | null {
  const n = name.toLowerCase()
  for (const [needle, kind] of KIND_HINTS) {
    if (n.includes(needle)) return kind
  }
  return null
}

function keepSymbol(name: string): boolean {
  if (!name || name.startsWith('$') || name.startsWith('.')) return false
  // Skip thread stack buffers — those are not wait queues.
  const n = name.toLowerCase()
  if (n.includes('stack') && !n.includes('k_stack')) return false
  return true
}

/** Collect data objects that might embed a wait queue. */
export function buildWaitObjects(elf: Uint8Array): WaitObject[] {
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
  const out: WaitObject[] = []

  for (let i = 0; i < eShnum; i++) {
    const sh = eShoff + i * eShentsize
    if (u32(sh + 4) !== 2) continue
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
      if (shndx === SHN_UNDEF || value === 0) continue
      if (size < MIN_SIZE || size > MAX_SIZE) continue

      let end = nameOff
      while (end < strtab.length && strtab[end] !== 0) end++
      const name = decoder.decode(strtab.subarray(nameOff, end))
      if (!keepSymbol(name)) continue
      out.push({ name, addr: value, size, kind: classifyWaitObject(name) })
    }
  }

  return out.sort((a, b) => a.size - b.size || a.addr - b.addr)
}

/**
 * Resolve a `pended_on` wait-queue pointer to a named object.
 * Prefers exact address match (wait_q is often the first field).
 * Containment matches only count when the symbol looks like a sync primitive
 * (`kind` set) — bare blobs like `shell_uart_ctx` are not wait objects.
 */
export function findWaitObject(objects: WaitObject[], pendedOn: number): WaitObject | null {
  if (!pendedOn) return null
  for (const o of objects) {
    if (o.addr === pendedOn) return o
  }
  let best: WaitObject | null = null
  for (const o of objects) {
    if (!o.kind) continue
    if (pendedOn < o.addr || pendedOn >= o.addr + o.size) continue
    if (!best || o.size < best.size) best = o
  }
  return best
}
