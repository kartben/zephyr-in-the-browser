/**
 * Zephyr CONFIG_OBJ_CORE live-object discovery.
 *
 * The ELF provides the section bounds and DWARF member offsets; stopped guest
 * memory provides the live state. Object types are built at link time in an
 * iterable section (`_k_obj_type_list_*`), each with the ranges of its
 * statically defined objects, and the kernel links them into z_obj_type_list
 * at boot. Objects initialized at run time are referenced from a fixed table,
 * `registry` in kernel/obj_core.c, so dynamically initialized objects are
 * included.
 *
 * This is how Zephyr main lays object cores out since 2026-09-29. Images from
 * before that, which linked objects into per-type lists, are not read.
 */

import { dwarfStruct, type DwarfStruct } from '@/debug/dwarfMembers'
import {
  dataSymbolsByName,
  elfDataSymbolList,
  readElfVirtual,
  type ElfTypedSymbol,
} from '@/debug/elfSymbols'
import { elfPointerBytes } from '@/debug/elfSections'
import { isRing, type MsgqRing, type MsgqRingSnapshot } from '@/debug/kernel/msgqRing'
import type { MemReader, ZephyrThread } from '@/debug/kernel/threads'

export interface ObjectCoreField {
  label: string
  value: string
  /** Optional address behind a pointer-valued field. */
  addr?: number
  /** The number a numeric field shows, as read. */
  num?: number
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
  /** True for a permanent object, walked from one of its type's static ranges. */
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

type Layouts = Record<string, Record<string, number>>

export interface ObjectCoreMeta {
  ptrBytes: 4 | 8
  typeListAddr: number
  /** The `_k_obj_type_list_*` section as linked: every type defined at build time. */
  staticTypes: ObjectTypeInfo[]
  /** kernel/obj_core.c's `registry`; zero slots when the image has none. */
  registryAddr: number
  registrySlots: number
  statsEnabled: boolean
  /** DWARF layouts of struct k_obj_type, k_obj_range, k_obj_core and obj_core_slot. */
  typeMembers: Record<string, number>
  typeSize: number
  rangeMembers: Record<string, number>
  rangeSize: number
  /** Entries in k_obj_type.statics (K_OBJ_TYPE_MAX_RANGES). */
  maxRanges: number
  coreMembers: Record<string, number>
  slotMembers: Record<string, number>
  slotSize: number
  layouts: Layouts
  /** DWARF byte size of each kernel object struct. */
  structSizes: Record<string, number>
  symbols: ElfTypedSymbol[]
}

/** One permanent object range of a type (struct k_obj_range). */
interface ObjectRange {
  start: number
  end: number
  stride: number
  /** The elements are pointers to the objects. */
  indirect: boolean
}

/** A struct k_obj_type, decoded. */
interface ObjectTypeInfo {
  addr: number
  /** Next type in z_obj_type_list, 0 at the end. */
  next: number
  id: number
  coreOffset: number
  ranges: ObjectRange[]
  /** Registrations refused because the registry was full. */
  dropped: number
  statsDesc: number
}

/**
 * What parsing needs from an image. parseObjectCoreMeta() reads it from the
 * ELF; tests describe a small one instead.
 */
export interface ObjectCoreImage {
  ptrBytes: 4 | 8
  /** Data and linker symbols in symbol-table order, statics with their file. */
  symbols: readonly ElfTypedSymbol[]
  struct(name: string): DwarfStruct | null
  /** Link-time bytes at an address; null for .bss and unmapped addresses. */
  readStatic(addr: number, length: number): Uint8Array | null
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
  QUEU: 'Queues',
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
  queue: 'QUEU',
  queues: 'QUEU',
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
  QUEU: 'k_queue',
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
/** Registry slots read per stop: 16 KiB of slot table on a 64-bit guest. */
const MAX_REGISTRY_SLOTS = 1024
/**
 * Bytes per memory read for tables. QEMU's gdbstub answers at most 2 KiB per
 * `m` packet, and the default 128-slot registry is exactly that on a 64-bit
 * guest.
 */
const READ_CHUNK = 1024

function validMetaSymbol(symbol?: ElfTypedSymbol): symbol is ElfTypedSymbol {
  return Boolean(symbol && symbol.addr > 0)
}

/** A struct's DWARF layout, when it has a size and every member the walk reads. */
function structWith(
  image: ObjectCoreImage,
  name: string,
  members: string[],
): { size: number; members: Record<string, number> } | null {
  const struct = image.struct(name)
  if (!struct?.size) return null
  return members.every((member) => Object.hasOwn(struct.members, member))
    ? { size: struct.size, members: struct.members }
    : null
}

/** Parse the host-only metadata needed before any RSP reads are attempted. */
export function parseObjectCoreMeta(elf: Uint8Array): ObjectCoreMeta | null {
  return objectCoreMetaFromImage({
    ptrBytes: elfPointerBytes(elf),
    symbols: elfDataSymbolList(elf),
    struct: (name) => dwarfStruct(elf, name),
    readStatic: (addr, length) => readElfVirtual(elf, addr, length),
  })
}

/** {@link parseObjectCoreMeta} over an image description. */
export function objectCoreMetaFromImage(image: ObjectCoreImage): ObjectCoreMeta | null {
  const byName = dataSymbolsByName(image.symbols)
  const typeList = byName.get('z_obj_type_list')
  const sectionStart = byName.get('_k_obj_type_list_start')
  const sectionEnd = byName.get('_k_obj_type_list_end')
  if (!validMetaSymbol(typeList) || !validMetaSymbol(sectionStart) || !validMetaSymbol(sectionEnd)) {
    return null
  }
  // The walk reads these structs through the build's DWARF, which the
  // packaged images always carry.
  const typeStruct = structWith(image, 'k_obj_type', [
    'node',
    'id',
    'obj_core_offset',
    'statics',
    'dropped',
  ])
  const rangeStruct = structWith(image, 'k_obj_range', ['start', 'end', 'stride', 'indirect'])
  const coreStruct = structWith(image, 'k_obj_core', ['type'])
  const slotStruct = structWith(image, 'obj_core_slot', ['core', 'type'])
  if (!typeStruct || !rangeStruct || !coreStruct) return null
  const sectionSize = sectionEnd.addr - sectionStart.addr
  if (sectionSize < 0 || sectionSize % typeStruct.size !== 0) return null

  // A `static` array: fs.c has a `registry` too, so prefer obj_core.c's.
  const registries = image.symbols.filter(
    (s) => s.name === 'registry' && s.type === 1 && s.size > 0,
  )
  const registry =
    registries.find((s) => s.file === 'obj_core.c') ??
    (registries.length === 1 ? registries[0] : undefined)

  const layouts: Layouts = {}
  const structSizes: Record<string, number> = {}
  for (const name of LAYOUT_NAMES) {
    const struct = image.struct(name)
    layouts[name] = struct?.members ?? {}
    if (struct?.size) structSizes[name] = struct.size
  }

  const meta: ObjectCoreMeta = {
    ptrBytes: image.ptrBytes,
    typeListAddr: typeList.addr,
    staticTypes: [],
    registryAddr: registry && slotStruct ? registry.addr : 0,
    registrySlots: registry && slotStruct ? Math.floor(registry.size / slotStruct.size) : 0,
    statsEnabled:
      Object.hasOwn(coreStruct.members, 'stats') &&
      Object.hasOwn(typeStruct.members, 'stats_desc'),
    typeMembers: typeStruct.members,
    typeSize: typeStruct.size,
    rangeMembers: rangeStruct.members,
    rangeSize: rangeStruct.size,
    // statics[K_OBJ_TYPE_MAX_RANGES] ends where `dropped` begins.
    maxRanges: Math.floor(
      (typeStruct.members.dropped - typeStruct.members.statics) / rangeStruct.size,
    ),
    coreMembers: coreStruct.members,
    slotMembers: slotStruct?.members ?? {},
    slotSize: slotStruct?.size ?? 0,
    layouts,
    structSizes,
    symbols: image.symbols
      .filter((s) => s.type === 1 && s.size > 0)
      .sort((a, b) => a.size - b.size || a.addr - b.addr),
  }

  // The types are fully initialized at build time, so the image says what
  // they are before the kernel has linked any of them.
  const section = image.readStatic(sectionStart.addr, sectionSize)
  for (let at = 0; section && at + meta.typeSize <= section.length; at += meta.typeSize) {
    meta.staticTypes.push(
      typeInfoAt(section.subarray(at, at + meta.typeSize), sectionStart.addr + at, meta),
    )
  }
  return meta
}

/** Decode one struct k_obj_type from its bytes. */
function typeInfoAt(bytes: Uint8Array, addr: number, meta: ObjectCoreMeta): ObjectTypeInfo {
  const p = meta.ptrBytes
  const t = meta.typeMembers
  const r = meta.rangeMembers
  const ranges: ObjectRange[] = []
  for (let i = 0; i < meta.maxRanges; i++) {
    const at = t.statics + i * meta.rangeSize
    const stride = sizeT(bytes, at + r.stride, p)
    // A zero stride ends the list, as it does in the kernel's own walk.
    if (stride === 0) break
    ranges.push({
      start: ptr(bytes, at + r.start, p),
      end: ptr(bytes, at + r.end, p),
      stride,
      indirect: (bytes[at + r.indirect] ?? 0) !== 0,
    })
  }
  const next = ptr(bytes, t.node, p)
  return {
    addr,
    next: next ? next - t.node : 0,
    id: u32(bytes, t.id),
    coreOffset: sizeT(bytes, t.obj_core_offset, p),
    ranges,
    dropped: u32(bytes, t.dropped),
    statsDesc: meta.statsEnabled ? ptr(bytes, t.stats_desc, p) : 0,
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

function usefulObjectSymbol(name: string): boolean {
  if (!name || name.startsWith('$') || name.startsWith('.')) return false
  if (name.startsWith('_k_') && name.includes('_list_')) return false
  if (name.startsWith('obj_type_')) return false
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
    fields.push({ label, value: value.toLocaleString(), num: value })
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

/** The `k_msgq` members that make up its ring, and how wide each one is. */
const MSGQ_RING_MEMBERS = [
  ['msg_size', 'size'],
  ['max_msgs', 'u32'],
  ['buffer_start', 'ptr'],
  ['buffer_end', 'ptr'],
  ['read_ptr', 'ptr'],
  ['write_ptr', 'ptr'],
  ['used_msgs', 'u32'],
] as const

/** Most of a queue's buffer a card copies out. Plenty for any queue a lesson draws. */
const MAX_RING_READ = 1024

/**
 * How many bytes from the start of a `k_msgq` cover its ring members, or null
 * when DWARF does not name them all.
 */
function msgqRingSpan(layout: Record<string, number>, ptrBytes: 4 | 8): number | null {
  let end = 0
  for (const [member, kind] of MSGQ_RING_MEMBERS) {
    const at = layout[member]
    if (at === undefined) return null
    end = Math.max(end, at + (kind === 'u32' ? 4 : ptrBytes))
  }
  return end
}

/**
 * A `k_msgq`'s ring, decoded from the struct's bytes: its geometry, both
 * pointers and the kernel's count. Null when DWARF does not name every member
 * or the bytes stop short of them, which is what lets a card fall back to the
 * plain row.
 */
export function decodeMsgqRing(
  bytes: Uint8Array,
  meta: Pick<ObjectCoreMeta, 'ptrBytes' | 'layouts'>,
): MsgqRing | null {
  const p = meta.ptrBytes
  const layout = meta.layouts.k_msgq ?? {}
  const span = msgqRingSpan(layout, p)
  if (span === null || bytes.length < span) return null
  return {
    msgSize: sizeT(bytes, layout.msg_size, p),
    maxMsgs: u32(bytes, layout.max_msgs),
    used: u32(bytes, layout.used_msgs),
    bufferStart: ptr(bytes, layout.buffer_start, p),
    bufferEnd: ptr(bytes, layout.buffer_end, p),
    readPtr: ptr(bytes, layout.read_ptr, p),
    writePtr: ptr(bytes, layout.write_ptr, p),
  }
}

/**
 * Read the message queue at `addr` as a ring: the struct's pointers and the
 * buffer behind them, one straight after the other, so both come from the same
 * stop. The buffer read is capped; a slot past the cap just has no bytes.
 *
 * Null when DWARF lacks the members, the struct will not read, or what it holds
 * is not a ring (an uninitialized queue, or an address that is not a queue).
 */
export async function readMsgqRing(
  meta: Pick<ObjectCoreMeta, 'ptrBytes' | 'layouts'>,
  addr: number,
  read: (addr: number, length: number) => Promise<Uint8Array | null>,
): Promise<MsgqRingSnapshot | null> {
  const span = msgqRingSpan(meta.layouts.k_msgq ?? {}, meta.ptrBytes)
  if (span === null) return null
  let struct: Uint8Array | null
  try {
    struct = await read(addr, span)
  } catch {
    return null
  }
  const ring = struct ? decodeMsgqRing(struct, meta) : null
  if (!ring || !isRing(ring)) return null
  let bytes: Uint8Array | null
  try {
    bytes = await read(ring.bufferStart, Math.min(ring.bufferEnd - ring.bufferStart, MAX_RING_READ))
  } catch {
    bytes = null
  }
  return { ...ring, bytes }
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
  const statsAddr = ptr(coreBytes, meta.coreMembers.stats, p)
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

/** Read a table that may be bigger than one gdbstub packet allows. */
async function readChunked(read: MemReader, addr: number, length: number): Promise<Uint8Array> {
  if (length <= READ_CHUNK) return read(addr, length)
  const out = new Uint8Array(length)
  for (let at = 0; at < length; at += READ_CHUNK) {
    out.set(await read(addr + at, Math.min(READ_CHUNK, length - at)), at)
  }
  return out
}

/**
 * Walk every object type and its objects: the type's permanent ranges, then the
 * registry entries that point at it. This is the order
 * k_obj_type_walk_unlocked() visits them in, with its checks: an object counts
 * only while its core still carries the type, which is how the kernel tells a
 * live object from reused storage.
 */
export async function readObjectCores(
  meta: ObjectCoreMeta,
  read: MemReader,
): Promise<ObjectCoreSnapshot> {
  const p = meta.ptrBytes
  const tagAt = meta.coreMembers.type
  const coreReadSize = (meta.statsEnabled ? Math.max(tagAt, meta.coreMembers.stats) : tagAt) + p
  const types: ZephyrObjectType[] = []
  const seenTypes = new Set<number>()
  let totalObjects = 0
  let statsCount = 0
  let truncated = false

  const slotCount = Math.min(meta.registrySlots, MAX_REGISTRY_SLOTS)
  if (meta.registrySlots > slotCount) truncated = true
  const slotBytes =
    slotCount > 0
      ? await readChunked(read, meta.registryAddr, slotCount * meta.slotSize)
      : new Uint8Array(0)
  const slots: { core: number; type: number }[] = []
  for (let i = 0; i < slotCount; i++) {
    const at = i * meta.slotSize
    const core = ptr(slotBytes, at + meta.slotMembers.core, p)
    if (core) slots.push({ core, type: ptr(slotBytes, at + meta.slotMembers.type, p) })
  }

  const decodeObject = async ({
    typeAddr,
    id,
    code,
    objectAddr,
    coreAddr,
    objectSize,
    staticObject,
    coreBytes,
    statsDescAddr,
    beforeInit,
  }: {
    typeAddr: number
    id: number
    code: string
    objectAddr: number
    coreAddr: number
    objectSize: number | null
    staticObject: boolean
    coreBytes: Uint8Array | null
    statsDescAddr: number
    beforeInit: boolean
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
    // the boot stop, so defer their decoded fields.
    if (!beforeInit || code === 'MSGQ' || code === 'SEM4') {
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
      staticObject,
      fields,
      stats,
    }
  }

  /** One type and its objects; `live` once the kernel has linked the type. */
  const walkType = async (info: ObjectTypeInfo, live: boolean) => {
    const code = typeCode(info.id)
    const objectSize = typeObjectSize(info, code, meta)
    const group: ZephyrObjectType = {
      addr: info.addr,
      id: info.id,
      code,
      name: typeName(code),
      objectSize,
      objects: [],
    }
    types.push(group)
    // A full registry refused objects that no walk can report.
    if (info.dropped > 0) truncated = true
    const full = () =>
      group.objects.length >= MAX_OBJECTS_PER_TYPE || totalObjects >= MAX_OBJECTS

    // Permanent objects, walked in place.
    for (const range of info.ranges) {
      for (const objectAddr of await rangeObjects(range, read, p)) {
        if (full()) {
          truncated = true
          break
        }
        const coreAddr = objectAddr + info.coreOffset
        let coreBytes: Uint8Array | null = null
        if (live) {
          coreBytes = await read(coreAddr, coreReadSize)
          // An element that was never initialized does not carry the type.
          if (ptr(coreBytes, tagAt, p) !== info.addr) continue
        }
        group.objects.push(
          await decodeObject({
            typeAddr: info.addr,
            id: info.id,
            code,
            objectAddr,
            coreAddr,
            objectSize,
            staticObject: true,
            coreBytes,
            statsDescAddr: live ? info.statsDesc : 0,
            beforeInit: !live,
          }),
        )
        totalObjects++
      }
    }

    // Objects initialized at run time, from the registry.
    for (const slot of slots) {
      if (slot.type !== info.addr || slot.core < info.coreOffset) continue
      if (group.objects.some((object) => object.coreAddr === slot.core)) continue
      if (full()) {
        truncated = true
        break
      }
      let coreBytes: Uint8Array
      try {
        coreBytes = await read(slot.core, coreReadSize)
      } catch {
        continue
      }
      // Storage reused by something else no longer carries the type: stale.
      if (ptr(coreBytes, tagAt, p) !== info.addr) continue
      group.objects.push(
        await decodeObject({
          typeAddr: info.addr,
          id: info.id,
          code,
          objectAddr: slot.core - info.coreOffset,
          coreAddr: slot.core,
          objectSize,
          staticObject: false,
          coreBytes,
          statsDescAddr: info.statsDesc,
          beforeInit: false,
        }),
      )
      totalObjects++
    }
  }

  const head = ptr(await read(meta.typeListAddr, p), 0, p)
  let typeAddr = head ? head - meta.typeMembers.node : 0
  while (typeAddr && types.length < MAX_TYPES && totalObjects < MAX_OBJECTS) {
    if (seenTypes.has(typeAddr)) {
      truncated = true
      break
    }
    seenTypes.add(typeAddr)
    const info = typeInfoAt(await read(typeAddr, meta.typeSize), typeAddr, meta)
    await walkType(info, true)
    typeAddr = info.next
  }
  if (typeAddr) truncated = true

  // Until obj_core_init_all() links the types, the list is empty and only the
  // image knows them, and their static objects' cores are not initialized
  // yet either. Seed those objects from the ranges so the initial GDB stop can
  // provide names and fixed bounds before application code starts.
  for (const info of meta.staticTypes) {
    if (seenTypes.has(info.addr)) continue
    if (types.length >= MAX_TYPES) {
      truncated = true
      break
    }
    await walkType(info, false)
  }

  return {
    types: types.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    objectCount: totalObjects,
    statsCount,
    truncated,
  }
}

/** The object addresses in one permanent range: its elements, or what they point to. */
async function rangeObjects(range: ObjectRange, read: MemReader, p: 4 | 8): Promise<number[]> {
  if (range.end <= range.start) return []
  // The kernel steps `elem < end`, so a partial last element still counts.
  const count = Math.min(Math.ceil((range.end - range.start) / range.stride), MAX_OBJECTS)
  if (!range.indirect) {
    return Array.from({ length: count }, (_, i) => range.start + i * range.stride)
  }
  const table = await readChunked(read, range.start, count * range.stride)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const addr = ptr(table, i * range.stride, p)
    if (addr) out.push(addr)
  }
  return out
}

/**
 * sizeof() the type's objects: DWARF knows the kernel's own structs. For any
 * other type, the first direct range steps over the objects themselves.
 */
function typeObjectSize(
  info: ObjectTypeInfo,
  code: string,
  meta: ObjectCoreMeta,
): number | null {
  const struct = STRUCT_FOR_CODE[code]
  const size = struct ? meta.structSizes[struct] : undefined
  if (size) return size
  return info.ranges.find((range) => !range.indirect)?.stride ?? null
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

/**
 * Each thread's own priority, by address: the one it runs at when no waiter
 * lends it theirs. A mutex owner running on a loan reads the lent priority,
 * but the kernel kept the one it had before: on the thread since Zephyr's
 * mutexes chain their loans (`orig_prio`, taken with its first mutex), and
 * before that on each mutex it holds (`owner_orig_prio`). The first mutex
 * taken predates any loan when mutexes go back in the reverse order, so the
 * least urgent of these is the thread's own.
 */
export function ownThreadPriorities(
  threads: readonly ZephyrThread[],
  objects: ObjectCoreSnapshot | null,
): Map<number, number> {
  const own = new Map<number, number>()
  const byAddr = new Map(threads.map((thread) => [thread.addr, thread]))
  for (const thread of threads) if (thread.prio !== null) own.set(thread.addr, thread.prio)
  const mutexes = objects?.types.find((type) => type.code === 'MUTX')?.objects ?? []
  for (const mutex of mutexes) {
    const owner = mutex.fields.find((field) => field.label === 'Owner')?.addr
    if (owner === undefined) continue
    const taken =
      byAddr.get(owner)?.origPrio ??
      mutex.fields.find((field) => field.label === 'Owner base priority')?.num
    const prio = own.get(owner)
    if (prio !== undefined && taken != null) own.set(owner, Math.max(prio, taken))
  }
  return own
}
