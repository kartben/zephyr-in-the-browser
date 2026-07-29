/**
 * Zephyr CONFIG_OBJ_CORE live-object discovery.
 *
 * The ELF provides the object-core descriptor bounds and DWARF member offsets;
 * stopped guest memory provides the live z_obj_type_list and each type's object
 * list. This deliberately walks the live lists rather than only the iterable
 * sections so dynamically initialized objects are included.
 */

import { dwarfStructMembers } from '@/debug/dwarfMembers'
import {
  buildElfDataSymbols,
  type ElfTypedSymbol,
} from '@/debug/elfSymbols'
import { elfPointerBytes } from '@/debug/elfSections'
import type { MemReader } from '@/debug/kernel/threads'

export interface ObjectCoreField {
  label: string
  value: string
  /** Optional address behind a pointer-valued field. */
  addr?: number
}

export interface ObjectCoreStats {
  addr: number
  rawSize: number
  querySize: number
  fields: ObjectCoreField[]
  rawHex: string
}

export interface ZephyrKernelObject {
  addr: number
  coreAddr: number
  typeAddr: number
  typeId: number
  typeCode: string
  typeName: string
  name: string
  size: number | null
  /** Maximum entries/permits/blocks when the object type has a fixed bound. */
  capacity: number | null
  /** True when the object address lies in the type descriptor's static range. */
  staticObject: boolean
  fields: ObjectCoreField[]
  stats: ObjectCoreStats | null
}

export interface ZephyrObjectType {
  addr: number
  id: number
  code: string
  name: string
  objectSize: number | null
  objects: ZephyrKernelObject[]
}

export interface ObjectCoreSnapshot {
  types: ZephyrObjectType[]
  objectCount: number
  statsCount: number
  truncated: boolean
}

interface ObjectDescriptor {
  typeAddr: number
  objectsStart: number
  objectsEnd: number
  coreOffset: number
  objectSize: number
  typeId: number
  statsDesc: number
}

type Layouts = Record<string, Record<string, number>>

export interface ObjectCoreMeta {
  ptrBytes: 4 | 8
  typeListAddr: number
  descriptorStart: number
  descriptorEnd: number
  descriptorSize: number
  statsEnabled: boolean
  typeMembers: Record<string, number>
  coreMembers: Record<string, number>
  layouts: Layouts
  symbols: ElfTypedSymbol[]
}

const TYPE_NAMES: Record<string, string> = {
  COND: 'Condition variables',
  CPU_: 'CPUs',
  EVNT: 'Events',
  FIFO: 'FIFOs',
  KRNL: 'Kernel',
  LIFO: 'LIFOs',
  MBLK: 'Memory blocks',
  MBOX: 'Mailboxes',
  SLAB: 'Memory slabs',
  MSGQ: 'Message queues',
  MUTX: 'Mutexes',
  PIPE: 'Pipes',
  SEM4: 'Semaphores',
  STCK: 'Stacks',
  THRD: 'Threads',
  TIMR: 'Timers',
}

/**
 * The names a person would use for a type, mapped to Zephyr's four-letter code.
 *
 * The codes are `K_OBJ_TYPE_ID_GEN("SEM4")` and friends — exactly what the
 * kernel stamps into each `k_obj_type` — and nobody writing a tour should have
 * to know that. Both spellings are accepted; `sem` and `SEM4` are the same ask.
 */
const TYPE_ALIASES: Record<string, string> = {
  condvar: 'COND',
  condvars: 'COND',
  cpu: 'CPU_',
  cpus: 'CPU_',
  event: 'EVNT',
  events: 'EVNT',
  fifo: 'FIFO',
  fifos: 'FIFO',
  kernel: 'KRNL',
  lifo: 'LIFO',
  lifos: 'LIFO',
  mailbox: 'MBOX',
  mailboxes: 'MBOX',
  mbox: 'MBOX',
  memblock: 'MBLK',
  memblocks: 'MBLK',
  msgq: 'MSGQ',
  msgqs: 'MSGQ',
  mutex: 'MUTX',
  mutexes: 'MUTX',
  pipe: 'PIPE',
  pipes: 'PIPE',
  sem: 'SEM4',
  semaphore: 'SEM4',
  semaphores: 'SEM4',
  slab: 'SLAB',
  slabs: 'SLAB',
  stack: 'STCK',
  stacks: 'STCK',
  thread: 'THRD',
  threads: 'THRD',
  timer: 'TIMR',
  timers: 'TIMR',
}

/** Resolve a written type name to its object-core code, or null. */
export function objectTypeCode(name: string): string | null {
  const raw = name.trim()
  if (raw === '') return null
  const upper = raw.toUpperCase()
  if (Object.hasOwn(TYPE_NAMES, upper)) return upper
  return TYPE_ALIASES[raw.toLowerCase()] ?? null
}

/** Every type name a tour may write, for the docs and for validation. */
export const OBJECT_TYPES = [...new Set(Object.keys(TYPE_ALIASES))].sort()

const STRUCT_FOR_CODE: Record<string, string> = {
  COND: 'k_condvar',
  CPU_: '_cpu',
  EVNT: 'k_event',
  FIFO: 'k_fifo',
  KRNL: 'z_kernel',
  LIFO: 'k_lifo',
  MBLK: 'sys_mem_blocks',
  MBOX: 'k_mbox',
  SLAB: 'k_mem_slab',
  MSGQ: 'k_msgq',
  MUTX: 'k_mutex',
  PIPE: 'k_pipe',
  SEM4: 'k_sem',
  STCK: 'k_stack',
  THRD: 'k_thread',
  TIMR: 'k_timer',
}

const LAYOUT_NAMES = [
  ...new Set(Object.values(STRUCT_FOR_CODE)),
  'k_mem_slab_info',
  'sys_mem_blocks_info',
  'k_cycle_stats',
] as const

const MAX_TYPES = 64
const MAX_OBJECTS = 512
const MAX_OBJECTS_PER_TYPE = 256
const MAX_OBJECT_READ = 512
const MAX_STATS_READ = 512

function align(value: number, by: number): number {
  return Math.ceil(value / by) * by
}

function getOffset(
  members: Record<string, number>,
  name: string,
  fallback: number,
): number {
  return members[name] ?? fallback
}

function validMetaSymbol(symbol?: ElfTypedSymbol): symbol is ElfTypedSymbol {
  return Boolean(symbol && symbol.addr > 0)
}

/** Parse the host-only metadata needed before any RSP reads are attempted. */
export function parseObjectCoreMeta(elf: Uint8Array): ObjectCoreMeta | null {
  const symbols = buildElfDataSymbols(elf)
  const typeList = symbols.get('z_obj_type_list')
  const descStart = symbols.get('_k_obj_core_desc_list_start')
  const descEnd = symbols.get('_k_obj_core_desc_list_end')
  if (!validMetaSymbol(typeList) || !validMetaSymbol(descStart) || !validMetaSymbol(descEnd)) {
    return null
  }

  const ptrBytes = elfPointerBytes(elf)
  const coreMembers = dwarfStructMembers(elf, 'k_obj_core')
  const typeMembers = dwarfStructMembers(elf, 'k_obj_type')
  const descriptorSymbol = [...symbols.values()].find(
    (symbol) =>
      symbol.name.startsWith('_obj_core_desc_') &&
      symbol.addr >= descStart.addr &&
      symbol.addr < descEnd.addr &&
      symbol.size > 0,
  )
  const baseDescriptorSize = align(ptrBytes * 5 + 4, ptrBytes)
  const statsDescriptorSize = baseDescriptorSize + ptrBytes * 3
  const statsEnabled =
    Object.hasOwn(coreMembers, 'stats') || descriptorSymbol?.size === statsDescriptorSize
  // k_obj_core_desc has six base fields. The uint32 type_id is followed by
  // pointer alignment when the optional stats fields are present.
  const descriptorSize =
    descriptorSymbol?.size || (statsEnabled ? statsDescriptorSize : baseDescriptorSize)
  if (
    descEnd.addr <= descStart.addr ||
    descriptorSize <= 0 ||
    (descEnd.addr - descStart.addr) % descriptorSize !== 0
  ) {
    return null
  }

  const layouts: Layouts = {}
  for (const name of LAYOUT_NAMES) layouts[name] = dwarfStructMembers(elf, name)

  return {
    ptrBytes,
    typeListAddr: typeList.addr,
    descriptorStart: descStart.addr,
    descriptorEnd: descEnd.addr,
    descriptorSize,
    statsEnabled,
    typeMembers,
    coreMembers,
    layouts,
    symbols: [...symbols.values()]
      .filter((s) => s.type === 1 && s.size > 0)
      .sort((a, b) => a.size - b.size || a.addr - b.addr),
  }
}

function u32(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.length) return 0
  return (
    (bytes[at]! |
      (bytes[at + 1]! << 8) |
      (bytes[at + 2]! << 16) |
      (bytes[at + 3]! << 24)) >>>
    0
  )
}

function i32(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) | 0
}

function u64(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 8 > bytes.length) return 0
  return u32(bytes, at) + u32(bytes, at + 4) * 0x1_0000_0000
}

function ptr(bytes: Uint8Array, at: number, ptrBytes: 4 | 8): number {
  return ptrBytes === 4 ? u32(bytes, at) : u64(bytes, at)
}

function sizeT(bytes: Uint8Array, at: number, ptrBytes: 4 | 8): number {
  return ptr(bytes, at, ptrBytes)
}

function typeCode(id: number): string {
  let out = ''
  for (const shift of [24, 16, 8, 0]) {
    const c = (id >>> shift) & 0xff
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '?'
  }
  return out
}

function typeName(code: string): string {
  return TYPE_NAMES[code] ?? `Type ${code}`
}

function descriptorAt(
  bytes: Uint8Array,
  at: number,
  meta: ObjectCoreMeta,
): ObjectDescriptor {
  const p = meta.ptrBytes
  const typeIdAt = p * 5
  const statsDescAt = align(typeIdAt + 4, p)
  return {
    typeAddr: ptr(bytes, at, p),
    objectsStart: ptr(bytes, at + p, p),
    objectsEnd: ptr(bytes, at + p * 2, p),
    coreOffset: sizeT(bytes, at + p * 3, p),
    objectSize: sizeT(bytes, at + p * 4, p),
    typeId: u32(bytes, at + typeIdAt),
    statsDesc: meta.statsEnabled ? ptr(bytes, at + statsDescAt, p) : 0,
  }
}

function usefulObjectSymbol(name: string): boolean {
  if (!name || name.startsWith('$') || name.startsWith('.')) return false
  if (name.startsWith('_k_') && name.includes('_list_')) return false
  if (name.startsWith('_obj_core_desc_') || name.startsWith('obj_type_')) return false
  return true
}

function symbolForObject(
  symbols: ElfTypedSymbol[],
  addr: number,
  objectSize: number | null,
): { name: string; symbol: ElfTypedSymbol } | null {
  for (const s of symbols) {
    if (s.addr !== addr || !usefulObjectSymbol(s.name)) continue
    return { name: s.name, symbol: s }
  }
  let best: ElfTypedSymbol | null = null
  for (const s of symbols) {
    if (!usefulObjectSymbol(s.name) || addr < s.addr || addr >= s.addr + s.size) continue
    if (!best || s.size < best.size) best = s
  }
  if (!best) return null
  if (
    objectSize &&
    objectSize > 0 &&
    best.size % objectSize === 0 &&
    (addr - best.addr) % objectSize === 0
  ) {
    const index = Math.floor((addr - best.addr) / objectSize)
    return { name: index ? `${best.name}[${index}]` : best.name, symbol: best }
  }
  return { name: `${best.name}+0x${(addr - best.addr).toString(16)}`, symbol: best }
}

function addNumber(
  fields: ObjectCoreField[],
  label: string,
  bytes: Uint8Array,
  at: number | undefined,
  kind: 'u32' | 'i32' | 'size' | 'ptr',
  ptrBytes: 4 | 8,
) {
  if (at === undefined || at < 0 || at >= bytes.length) return
  const value =
    kind === 'u32'
      ? u32(bytes, at)
      : kind === 'i32'
        ? i32(bytes, at)
        : sizeT(bytes, at, ptrBytes)
  if (kind === 'ptr') {
    fields.push({
      label,
      value: value ? `0x${value.toString(16)}` : 'none',
      ...(value ? { addr: value } : {}),
    })
  } else {
    fields.push({ label, value: value.toLocaleString() })
  }
}

function objectFields(
  code: string,
  bytes: Uint8Array,
  meta: ObjectCoreMeta,
): ObjectCoreField[] {
  const p = meta.ptrBytes
  const layout = meta.layouts[STRUCT_FOR_CODE[code] ?? ''] ?? {}
  const fields: ObjectCoreField[] = []
  if (code === 'SEM4') {
    addNumber(fields, 'Count', bytes, layout.count, 'u32', p)
    addNumber(fields, 'Limit', bytes, layout.limit, 'u32', p)
  } else if (code === 'MUTX') {
    addNumber(fields, 'Owner', bytes, layout.owner, 'ptr', p)
    addNumber(fields, 'Lock depth', bytes, layout.lock_count, 'u32', p)
    addNumber(fields, 'Owner base priority', bytes, layout.owner_orig_prio, 'i32', p)
  } else if (code === 'EVNT') {
    if (layout.events !== undefined) {
      fields.push({ label: 'Events', value: `0x${u32(bytes, layout.events).toString(16)}` })
    }
  } else if (code === 'MSGQ') {
    addNumber(fields, 'Message size', bytes, layout.msg_size, 'size', p)
    addNumber(fields, 'Used messages', bytes, layout.used_msgs, 'u32', p)
    addNumber(fields, 'Capacity', bytes, layout.max_msgs, 'u32', p)
  } else if (code === 'SLAB') {
    const info = layout.info
    const sub = meta.layouts.k_mem_slab_info ?? {}
    if (info !== undefined) {
      addNumber(fields, 'Blocks used', bytes, info + (sub.num_used ?? 0), 'u32', p)
      addNumber(fields, 'Blocks total', bytes, info + (sub.num_blocks ?? 0), 'u32', p)
      addNumber(fields, 'Block size', bytes, info + (sub.block_size ?? 0), 'size', p)
      if (sub.max_used !== undefined) {
        addNumber(fields, 'Peak blocks', bytes, info + sub.max_used, 'u32', p)
      }
    }
  } else if (code === 'STCK') {
    const baseAt = layout.base
    const nextAt = layout.next
    const topAt = layout.top
    if (baseAt !== undefined && nextAt !== undefined && topAt !== undefined) {
      const base = ptr(bytes, baseAt, p)
      const next = ptr(bytes, nextAt, p)
      const top = ptr(bytes, topAt, p)
      fields.push({ label: 'Entries used', value: Math.max(0, (next - base) / p).toLocaleString() })
      fields.push({ label: 'Capacity', value: Math.max(0, (top - base) / p).toLocaleString() })
    }
  } else if (code === 'TIMR') {
    addNumber(fields, 'Expirations', bytes, layout.status, 'u32', p)
    addNumber(fields, 'User data', bytes, layout.user_data, 'ptr', p)
  } else if (code === 'PIPE') {
    addNumber(fields, 'Waiting bytes', bytes, layout.waiting, 'size', p)
  } else if (code === 'MBLK') {
    const info = layout.info
    const sub = meta.layouts.sys_mem_blocks_info ?? {}
    if (info !== undefined) {
      addNumber(fields, 'Blocks total', bytes, info + (sub.num_blocks ?? 0), 'u32', p)
      if (sub.blk_sz_shift !== undefined) {
        const shift = bytes[info + sub.blk_sz_shift] ?? 0
        fields.push({ label: 'Block size', value: `${2 ** shift} B` })
      }
      addNumber(fields, 'Blocks used', bytes, sub.used_blocks === undefined ? undefined : info + sub.used_blocks, 'u32', p)
      addNumber(fields, 'Peak blocks', bytes, sub.max_used_blocks === undefined ? undefined : info + sub.max_used_blocks, 'u32', p)
    }
  }
  return fields
}

/**
 * Fixed runtime bound used by visualizations. Linked-list queues are
 * intentionally null: unlike msgq/stack/slab, they do not have a fixed cap.
 */
function objectCapacity(
  code: string,
  bytes: Uint8Array,
  meta: ObjectCoreMeta,
): number | null {
  const p = meta.ptrBytes
  const layout = meta.layouts[STRUCT_FOR_CODE[code] ?? ''] ?? {}
  let value: number | null = null
  if (code === 'MSGQ' && layout.max_msgs !== undefined) {
    value = u32(bytes, layout.max_msgs)
  } else if (code === 'SEM4' && layout.limit !== undefined) {
    value = u32(bytes, layout.limit)
  } else if (code === 'SLAB' && layout.info !== undefined) {
    const info = meta.layouts.k_mem_slab_info ?? {}
    if (info.num_blocks !== undefined) {
      value = u32(bytes, layout.info + info.num_blocks)
    }
  } else if (code === 'STCK') {
    if (layout.base !== undefined && layout.top !== undefined) {
      value = Math.max(0, (ptr(bytes, layout.top, p) - ptr(bytes, layout.base, p)) / p)
    }
  } else if (code === 'MBLK' && layout.info !== undefined) {
    const info = meta.layouts.sys_mem_blocks_info ?? {}
    if (info.num_blocks !== undefined) {
      value = u32(bytes, layout.info + info.num_blocks)
    }
  }
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}

function bytesHex(bytes: Uint8Array, limit = 32): string {
  return [...bytes.subarray(0, limit)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

function statsFields(
  code: string,
  bytes: Uint8Array,
  meta: ObjectCoreMeta,
): ObjectCoreField[] {
  const fields: ObjectCoreField[] = []
  const p = meta.ptrBytes
  if (code === 'THRD' || code === 'CPU_' || code === 'KRNL') {
    const layout = meta.layouts.k_cycle_stats ?? {}
    for (const [member, label] of [
      ['total', 'Total cycles'],
      ['current', 'Current window'],
      ['longest', 'Longest window'],
    ] as const) {
      const at = layout[member]
      if (at !== undefined) fields.push({ label, value: u64(bytes, at).toLocaleString() })
    }
    addNumber(fields, 'Windows', bytes, layout.num_windows, 'u32', p)
    if (layout.track_usage !== undefined) {
      fields.push({
        label: 'Collection',
        value: bytes[layout.track_usage] ? 'enabled' : 'disabled',
      })
    }
  } else if (code === 'SLAB') {
    const layout = meta.layouts.k_mem_slab_info ?? {}
    addNumber(fields, 'Blocks used', bytes, layout.num_used, 'u32', p)
    addNumber(fields, 'Blocks total', bytes, layout.num_blocks, 'u32', p)
    addNumber(fields, 'Block size', bytes, layout.block_size, 'size', p)
    addNumber(fields, 'Peak blocks', bytes, layout.max_used, 'u32', p)
  } else if (code === 'MBLK') {
    const layout = meta.layouts.sys_mem_blocks_info ?? {}
    addNumber(fields, 'Blocks total', bytes, layout.num_blocks, 'u32', p)
    addNumber(fields, 'Blocks used', bytes, layout.used_blocks, 'u32', p)
    addNumber(fields, 'Peak blocks', bytes, layout.max_used_blocks, 'u32', p)
  }
  return fields
}

async function readStats(
  code: string,
  coreBytes: Uint8Array,
  statsDescAddr: number,
  meta: ObjectCoreMeta,
  read: MemReader,
): Promise<ObjectCoreStats | null> {
  if (!meta.statsEnabled || !statsDescAddr) return null
  const p = meta.ptrBytes
  const statsAt = getOffset(meta.coreMembers, 'stats', p * 2)
  const statsAddr = ptr(coreBytes, statsAt, p)
  if (!statsAddr) return null

  try {
    const desc = await read(statsDescAddr, p * 2)
    const rawSize = sizeT(desc, 0, p)
    const querySize = sizeT(desc, p, p)
    if (rawSize <= 0 || rawSize > MAX_STATS_READ) return null
    const raw = await read(statsAddr, rawSize)
    return {
      addr: statsAddr,
      rawSize,
      querySize,
      fields: statsFields(code, raw, meta),
      rawHex: bytesHex(raw),
    }
  } catch {
    return null
  }
}

/** Walk every registered object type and its live object-core list. */
export async function readObjectCores(
  meta: ObjectCoreMeta,
  read: MemReader,
): Promise<ObjectCoreSnapshot> {
  const p = meta.ptrBytes
  const descriptorBytes = await read(
    meta.descriptorStart,
    meta.descriptorEnd - meta.descriptorStart,
  )
  const descriptorList: ObjectDescriptor[] = []
  const descriptors = new Map<number, ObjectDescriptor>()
  for (let at = 0; at + meta.descriptorSize <= descriptorBytes.length; at += meta.descriptorSize) {
    const desc = descriptorAt(descriptorBytes, at, meta)
    if (desc.typeAddr) {
      descriptorList.push(desc)
      descriptors.set(desc.typeAddr, desc)
    }
  }

  const nodeOff = getOffset(meta.typeMembers, 'node', 0)
  const listOff = getOffset(meta.typeMembers, 'list', p)
  const idOff = getOffset(meta.typeMembers, 'id', p * 3)
  const coreOffOff = getOffset(meta.typeMembers, 'obj_core_offset', align(idOff + 4, p))
  const statsDescOff = meta.statsEnabled
    ? getOffset(meta.typeMembers, 'stats_desc', coreOffOff + p)
    : -1
  const typeReadSize = Math.max(
    nodeOff + p,
    listOff + p * 2,
    idOff + 4,
    coreOffOff + p,
    statsDescOff + (meta.statsEnabled ? p : 0),
  )

  const listHead = ptr(await read(meta.typeListAddr, p), 0, p)
  const types: ZephyrObjectType[] = []
  const seenTypes = new Set<number>()
  let typeAddr = listHead
  let totalObjects = 0
  let statsCount = 0
  let truncated = false

  const decodeObject = async ({
    typeAddr,
    id,
    code,
    objectAddr,
    coreAddr,
    objectSize,
    descriptor,
    coreBytes,
    statsDescAddr,
    descriptorOnly,
  }: {
    typeAddr: number
    id: number
    code: string
    objectAddr: number
    coreAddr: number
    objectSize: number | null
    descriptor: ObjectDescriptor | undefined
    coreBytes: Uint8Array | null
    statsDescAddr: number
    descriptorOnly: boolean
  }): Promise<ZephyrKernelObject> => {
    const named = symbolForObject(meta.symbols, objectAddr, objectSize)
    const fallbackName = `${code.toLowerCase().replace(/_+$/, '')}@${objectAddr.toString(16)}`
    const readSize = Math.min(
      objectSize ?? Math.max(coreAddr - objectAddr + p * 3, 128),
      MAX_OBJECT_READ,
    )
    let fields: ObjectCoreField[] = []
    let capacity: number | null = null
    // MSGQ and SEM4 bounds are part of their static initializers. Other
    // object bodies (notably k_stack base/top) may not be initialized yet at
    // the boot-stop descriptor pass, so defer their decoded fields.
    if (!descriptorOnly || code === 'MSGQ' || code === 'SEM4') {
      try {
        const objectBytes = await read(objectAddr, readSize)
        fields = objectFields(code, objectBytes, meta)
        capacity = objectCapacity(code, objectBytes, meta)
      } catch {
        /* Object identity is still useful when its full body is unreadable. */
      }
    }
    const stats =
      coreBytes && statsDescAddr
        ? await readStats(code, coreBytes, statsDescAddr, meta, read)
        : null
    if (stats) statsCount++

    return {
      addr: objectAddr,
      coreAddr,
      typeAddr,
      typeId: id,
      typeCode: code,
      typeName: typeName(code),
      name: named?.name ?? fallbackName,
      size: objectSize ?? named?.symbol.size ?? null,
      capacity,
      staticObject: Boolean(
        descriptor &&
          objectAddr >= descriptor.objectsStart &&
          objectAddr < descriptor.objectsEnd,
      ),
      fields,
      stats,
    }
  }

  while (typeAddr && types.length < MAX_TYPES && totalObjects < MAX_OBJECTS) {
    if (seenTypes.has(typeAddr)) {
      truncated = true
      break
    }
    seenTypes.add(typeAddr)

    const typeBytes = await read(typeAddr, typeReadSize)
    const nextType = ptr(typeBytes, nodeOff, p)
    const id = u32(typeBytes, idOff)
    const code = typeCode(id)
    const coreOffset = sizeT(typeBytes, coreOffOff, p)
    const statsDescAddr =
      meta.statsEnabled && statsDescOff >= 0 ? ptr(typeBytes, statsDescOff, p) : 0
    const descriptor = descriptors.get(typeAddr)
    const objectSize =
      descriptor && descriptor.objectSize > 0 ? descriptor.objectSize : null
    const group: ZephyrObjectType = {
      addr: typeAddr,
      id,
      code,
      name: typeName(code),
      objectSize,
      objects: [],
    }

    let coreAddr = ptr(typeBytes, listOff, p)
    const seenCores = new Set<number>()
    while (
      coreAddr &&
      group.objects.length < MAX_OBJECTS_PER_TYPE &&
      totalObjects < MAX_OBJECTS
    ) {
      if (seenCores.has(coreAddr)) {
        truncated = true
        break
      }
      seenCores.add(coreAddr)

      const coreReadSize = meta.statsEnabled ? p * 3 : p * 2
      const coreBytes = await read(coreAddr, coreReadSize)
      const nextCore = ptr(coreBytes, getOffset(meta.coreMembers, 'node', 0), p)
      const linkedType = ptr(coreBytes, getOffset(meta.coreMembers, 'type', p), p)
      if (linkedType !== typeAddr || coreOffset > coreAddr) {
        truncated = true
        break
      }
      const objectAddr = coreAddr - coreOffset
      group.objects.push(
        await decodeObject({
          typeAddr,
          id,
          code,
          objectAddr,
          coreAddr,
          objectSize,
          descriptor,
          coreBytes,
          statsDescAddr,
          descriptorOnly: false,
        }),
      )
      totalObjects++
      coreAddr = nextCore
    }
    if (coreAddr) truncated = true
    types.push(group)
    typeAddr = nextType
  }
  if (typeAddr) truncated = true

  // The descriptor section exists before z_obj_core_init_all() links the live
  // lists. Seed static objects from its address ranges so the initial GDB stop
  // can provide names and fixed bounds before application code starts.
  for (const descriptor of descriptorList) {
    if (
      descriptor.objectSize <= 0 ||
      descriptor.objectsEnd <= descriptor.objectsStart
    ) {
      continue
    }
    const code = typeCode(descriptor.typeId)
    let group = types.find((candidate) => candidate.addr === descriptor.typeAddr)
    if (!group) {
      if (types.length >= MAX_TYPES) {
        truncated = true
        break
      }
      group = {
        addr: descriptor.typeAddr,
        id: descriptor.typeId,
        code,
        name: typeName(code),
        objectSize: descriptor.objectSize,
        objects: [],
      }
      types.push(group)
    }
    for (
      let objectAddr = descriptor.objectsStart;
      objectAddr < descriptor.objectsEnd;
      objectAddr += descriptor.objectSize
    ) {
      if (group.objects.some((object) => object.addr === objectAddr)) continue
      if (group.objects.length >= MAX_OBJECTS_PER_TYPE || totalObjects >= MAX_OBJECTS) {
        truncated = true
        break
      }
      group.objects.push(
        await decodeObject({
          typeAddr: descriptor.typeAddr,
          id: descriptor.typeId,
          code,
          objectAddr,
          coreAddr: objectAddr + descriptor.coreOffset,
          objectSize: descriptor.objectSize,
          descriptor,
          coreBytes: null,
          statsDescAddr: 0,
          descriptorOnly: true,
        }),
      )
      totalObjects++
    }
  }

  return {
    types: types.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    objectCount: totalObjects,
    statsCount,
    truncated,
  }
}

/** Object-core inventory as wait-object inputs for the Threads status line. */
export function objectCoreWaitObjects(snapshot: ObjectCoreSnapshot) {
  const kinds: Record<string, string> = {
    COND: 'condvar',
    EVNT: 'event',
    FIFO: 'fifo',
    LIFO: 'lifo',
    MBOX: 'mbox',
    SLAB: 'slab',
    MSGQ: 'msgq',
    MUTX: 'mutex',
    PIPE: 'pipe',
    SEM4: 'sem',
    STCK: 'stack',
    TIMR: 'timer',
  }
  return snapshot.types.flatMap((type) => {
    const kind = kinds[type.code]
    if (!kind) return []
    return type.objects.map((obj) => ({
      name: obj.name,
      addr: obj.addr,
      size: obj.size ?? 1,
      kind,
    }))
  })
}

export function objectCoreThreadAddresses(snapshot: ObjectCoreSnapshot): number[] {
  return snapshot.types.find((type) => type.code === 'THRD')?.objects.map((o) => o.addr) ?? []
}
