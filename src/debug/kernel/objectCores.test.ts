import { describe, expect, it } from 'vitest'
import type { DwarfStruct } from '@/debug/dwarfMembers'
import type { ElfTypedSymbol } from '@/debug/elfSymbols'
import {
  decodeMsgqRing,
  objectCoreMetaFromImage,
  readMsgqRing,
  readObjectCores,
  type ObjectCoreImage,
} from '@/debug/kernel/objectCores'

function memoryReader(chunks: Map<number, Uint8Array>) {
  return async (addr: number, length: number) => {
    const out = new Uint8Array(length)
    for (const [base, bytes] of chunks) {
      for (let i = 0; i < bytes.length; i++) {
        const target = base + i
        if (target >= addr && target < addr + length) out[target - addr] = bytes[i]!
      }
    }
    return out
  }
}

const MUTX = 0x4d555458
const MSGQ = 0x4d534751
const SEM4 = 0x53454d34
const THRD = 0x54485244

/**
 * DWARF layouts as a qemu_cortex_a53 build of Zephyr main has them. k_thread
 * and k_msgq are trimmed to the members the walk reads.
 */
const A53_STRUCTS: Record<string, DwarfStruct> = {
  k_obj_type: {
    size: 152,
    members: {
      node: 0,
      id: 8,
      obj_core_offset: 16,
      statics: 24,
      dropped: 120,
      skipped: 124,
      stats_desc: 128,
      stats_offset: 136,
      stats_size: 144,
    },
  },
  k_obj_range: { size: 32, members: { start: 0, end: 8, stride: 16, indirect: 24 } },
  k_obj_core: { size: 16, members: { type: 0, stats: 8 } },
  obj_core_slot: { size: 16, members: { core: 0, type: 8 } },
  k_mutex: {
    size: 56,
    members: { wait_q: 0, owner: 16, lock_count: 24, held_node: 32, obj_core: 40 },
  },
  k_msgq: { size: 48, members: { msg_size: 0, max_msgs: 8, used_msgs: 12, obj_core: 32 } },
  k_thread: { size: 64, members: { obj_core: 32 } },
  k_cycle_stats: { size: 16, members: { total: 0, track_usage: 8 } },
}

/** A flat little-endian guest address space. */
function flatGuest() {
  const bytes = new Uint8Array(0xa000)
  const view = new DataView(bytes.buffer)
  return {
    u32: (addr: number, value: number) => view.setUint32(addr, value, true),
    u64: (addr: number, value: number) => view.setBigUint64(addr, BigInt(value), true),
    slice: (addr: number, length: number) => bytes.slice(addr, addr + length),
  }
}
type Guest = ReturnType<typeof flatGuest>

/** Reads the way QEMU's gdbstub answers them: E22 past 2 KiB, an error where unmapped. */
function gdbstubReader(guest: Guest, unmapped: [number, number] = [0, 0]) {
  return async (addr: number, length: number) => {
    if (length > 2048) throw new Error('memory read error: E22')
    if (addr >= unmapped[0] && addr < unmapped[1]) throw new Error('memory read error: E14')
    return guest.slice(addr, length)
  }
}

/** A struct k_obj_type in the A53 layout. */
function putType(
  guest: Guest,
  addr: number,
  type: {
    next?: number
    id: number
    coreOffset: number
    ranges?: [start: number, end: number, stride: number][]
    dropped?: number
    statsDesc?: number
  },
) {
  guest.u64(addr, type.next ?? 0)
  guest.u32(addr + 8, type.id)
  guest.u64(addr + 16, type.coreOffset)
  for (const [i, [start, end, stride]] of (type.ranges ?? []).entries()) {
    guest.u64(addr + 24 + i * 32, start)
    guest.u64(addr + 32 + i * 32, end)
    guest.u64(addr + 40 + i * 32, stride)
  }
  guest.u32(addr + 120, type.dropped ?? 0)
  guest.u64(addr + 128, type.statsDesc ?? 0)
}

type FixtureSymbol = Pick<ElfTypedSymbol, 'name' | 'addr'> & Partial<ElfTypedSymbol>

function a53Image(symbols: FixtureSymbol[], statics: Guest): ObjectCoreImage {
  return {
    ptrBytes: 8,
    symbols: symbols.map((s) => ({ size: 0, type: s.size ? 1 : 0, ...s })),
    struct: (name) => A53_STRUCTS[name] ?? null,
    readStatic: statics.slice,
  }
}

/**
 * The symbols of a registry-layout image: types in 0x2000..0x2130, the 160-slot
 * registry at 0x4000, and a same-named `registry` static of fs.c's in front.
 */
const REGISTRY_SYMBOLS: FixtureSymbol[] = [
  { name: 'z_obj_type_list', addr: 0x1000, size: 16 },
  { name: '_k_obj_type_list_start', addr: 0x2000 },
  { name: '_k_obj_type_list_end', addr: 0x2130 },
  { name: 'obj_type_mutex', addr: 0x2000, size: 152, file: 'mutex.c' },
  { name: 'obj_type_thread', addr: 0x2098, size: 152, file: 'thread.c' },
  { name: 'registry', addr: 0x0400, size: 64, file: 'fs.c' },
  { name: 'registry', addr: 0x4000, size: 160 * 16, file: 'obj_core.c' },
]

describe('object core metadata', () => {
  it('reads the build-time types, and the registry that is kernel/obj_core.c\'s', () => {
    const image = flatGuest()
    putType(image, 0x2000, { id: MUTX, coreOffset: 40, ranges: [[0x3000, 0x3070, 56]] })
    putType(image, 0x2098, { id: THRD, coreOffset: 32, statsDesc: 0x8000 })

    const meta = objectCoreMetaFromImage(a53Image(REGISTRY_SYMBOLS, image))
    expect(meta).toMatchObject({
      typeListAddr: 0x1000,
      statsEnabled: true,
      typeSize: 152,
      maxRanges: 3,
      registryAddr: 0x4000,
      registrySlots: 160,
      staticTypes: [
        {
          addr: 0x2000,
          id: MUTX,
          coreOffset: 40,
          ranges: [{ start: 0x3000, end: 0x3070, stride: 56, indirect: false }],
        },
        { addr: 0x2098, id: THRD, coreOffset: 32, ranges: [], statsDesc: 0x8000 },
      ],
    })
  })

  it('reads a 32-bit image', () => {
    const image = flatGuest()
    image.u32(0x1004, SEM4) // id
    image.u32(0x1008, 16) // obj_core_offset
    image.u32(0x100c, 0x3000) // statics[0].start
    image.u32(0x1010, 0x3030) // statics[0].end
    image.u32(0x1014, 24) // statics[0].stride

    // DWARF layouts as a qemu_cortex_m3 build of Zephyr main has them.
    const structs: Record<string, DwarfStruct> = {
      k_obj_type: {
        size: 80,
        members: {
          node: 0,
          id: 4,
          obj_core_offset: 8,
          statics: 12,
          dropped: 60,
          skipped: 64,
          stats_desc: 68,
          stats_offset: 72,
          stats_size: 76,
        },
      },
      k_obj_range: { size: 16, members: { start: 0, end: 4, stride: 8, indirect: 12 } },
      k_obj_core: { size: 8, members: { type: 0, stats: 4 } },
      obj_core_slot: { size: 8, members: { core: 0, type: 4 } },
      k_sem: { size: 24, members: { wait_q: 0, count: 8, limit: 12, obj_core: 16 } },
    }
    const meta = objectCoreMetaFromImage({
      ptrBytes: 4,
      symbols: [
        { name: 'z_obj_type_list', addr: 0x0800, size: 8, type: 1 },
        { name: '_k_obj_type_list_start', addr: 0x1000, size: 0, type: 0 },
        { name: '_k_obj_type_list_end', addr: 0x1050, size: 0, type: 0 },
        { name: 'registry', addr: 0x2000, size: 1024, type: 1, file: 'obj_core.c' },
      ],
      struct: (name) => structs[name] ?? null,
      readStatic: image.slice,
    })
    expect(meta).toMatchObject({
      statsEnabled: true,
      typeSize: 80,
      maxRanges: 3,
      registrySlots: 128,
      structSizes: { k_sem: 24 },
      staticTypes: [
        {
          addr: 0x1000,
          id: SEM4,
          coreOffset: 16,
          ranges: [{ start: 0x3000, end: 0x3030, stride: 24, indirect: false }],
        },
      ],
    })
  })

  it('finds no inventory in an image from older Zephyr, or one without DWARF', () => {
    // Before 2026-09-29: per-type object lists and a descriptor section.
    const older = objectCoreMetaFromImage({
      ptrBytes: 8,
      symbols: [
        { name: 'z_obj_type_list', addr: 0x1000, size: 16, type: 1 },
        { name: '_k_obj_core_desc_list_start', addr: 0x2000, size: 0, type: 0 },
        { name: '_k_obj_core_desc_list_end', addr: 0x2090, size: 0, type: 0 },
      ],
      struct: (name) =>
        name === 'k_obj_type'
          ? { size: 48, members: { node: 0, list: 8, id: 24, obj_core_offset: 32, stats_desc: 40 } }
          : null,
      readStatic: () => null,
    })
    expect(older).toBeNull()

    const stripped = { ...a53Image(REGISTRY_SYMBOLS, flatGuest()), struct: () => null }
    expect(objectCoreMetaFromImage(stripped)).toBeNull()
  })
})

describe('object core walk', () => {
  it('walks permanent ranges, then the registry entries that are still live', async () => {
    const guest = flatGuest()
    guest.u64(0x1000, 0x2000) // z_obj_type_list.head
    putType(guest, 0x2000, {
      next: 0x2098,
      id: MUTX,
      coreOffset: 40,
      ranges: [[0x3000, 0x3070, 56]],
    })
    putType(guest, 0x2098, { id: THRD, coreOffset: 32, statsDesc: 0x8000 })

    // K_MUTEX_DEFINE section: static_lock, then an element never initialized.
    guest.u64(0x3010, 0x6040) // owner: threads[1]
    guest.u32(0x3018, 1)
    guest.u64(0x3028, 0x2000) // obj_core.type

    // Mutexes and threads initialized at run time.
    guest.u64(0x5028, 0x2000) // fork_objs[0], unlocked
    guest.u64(0x5048, 0x6000) // fork_objs[1].owner: threads[0]
    guest.u32(0x5050, 1)
    guest.u64(0x5060, 0x2000)
    guest.u64(0x6020, 0x2098) // threads[0]
    guest.u64(0x6028, 0x8100) // obj_core.stats
    guest.u64(0x6060, 0x2098) // threads[1]
    guest.u64(0x7028, 0xdead0000) // reused storage: no longer a mutex

    const slots: [core: number, type: number][] = [
      [0x5028, 0x2000],
      [0x6020, 0x2098],
      [0, 0],
      [0x7028, 0x2000], // stale
      [0x5060, 0x2000],
      [0x9028, 0x2000], // unreadable
    ]
    for (const [i, [core, type]] of slots.entries()) {
      guest.u64(0x4000 + i * 16, core)
      guest.u64(0x4008 + i * 16, type)
    }
    // Past the first 2 KiB of the table, where one unchunked read would fail.
    guest.u64(0x4000 + 150 * 16, 0x6060)
    guest.u64(0x4008 + 150 * 16, 0x2098)

    guest.u64(0x8000, 16) // k_obj_core_stats_desc.raw_size
    guest.u64(0x8008, 48) // query_size
    guest.u64(0x8100, 987654) // k_cycle_stats.total
    guest.u32(0x8108, 1) // track_usage

    const meta = objectCoreMetaFromImage(
      a53Image(
        [
          ...REGISTRY_SYMBOLS,
          { name: 'static_lock', addr: 0x3000, size: 56 },
          { name: 'fork_objs', addr: 0x5000, size: 3 * 56 },
          { name: 'threads', addr: 0x6000, size: 2 * 64 },
        ],
        guest,
      ),
    )!
    const snapshot = await readObjectCores(meta, gdbstubReader(guest, [0x9000, 0xa000]))

    expect(snapshot).toMatchObject({ objectCount: 5, statsCount: 1, truncated: false })
    expect(snapshot.types.map((type) => [type.code, type.objectSize])).toEqual([
      ['MUTX', 56],
      ['THRD', 64],
    ])
    expect(snapshot.types[0]!.objects).toMatchObject([
      {
        name: 'static_lock',
        addr: 0x3000,
        coreAddr: 0x3028,
        staticObject: true,
        fields: [
          { label: 'Owner', value: '0x6040', addr: 0x6040 },
          { label: 'Lock depth', value: '1' },
        ],
      },
      {
        name: 'fork_objs',
        addr: 0x5000,
        staticObject: false,
        fields: [
          { label: 'Owner', value: 'none' },
          { label: 'Lock depth', value: '0' },
        ],
      },
      { name: 'fork_objs[1]', addr: 0x5038, size: 56, fields: [{ value: '0x6000' }, { value: '1' }] },
    ])
    expect(snapshot.types[1]!.objects).toMatchObject([
      {
        name: 'threads',
        addr: 0x6000,
        stats: {
          addr: 0x8100,
          rawSize: 16,
          querySize: 48,
          fields: [
            { label: 'Total cycles', value: '987,654' },
            { label: 'Collection', value: 'enabled' },
          ],
        },
      },
      { name: 'threads[1]', addr: 0x6040, stats: null },
    ])
  })

  it('seeds permanent objects from the image before the kernel links the types', async () => {
    // At the first stop the type list is empty, and on an XIP board the RAM
    // copy of the type section is not even initialized yet: the image has it.
    const image = flatGuest()
    putType(image, 0x2000, { id: MSGQ, coreOffset: 32, ranges: [[0x3000, 0x3060, 48]] })
    const guest = flatGuest()
    guest.u64(0x3000, 4) // boot_queue.msg_size
    guest.u32(0x3008, 8) // max_msgs
    guest.u64(0x3030, 16) // alarm_queue.msg_size
    guest.u32(0x3038, 2)

    const meta = objectCoreMetaFromImage(
      a53Image(
        [
          { name: 'z_obj_type_list', addr: 0x1000, size: 16 },
          { name: '_k_obj_type_list_start', addr: 0x2000 },
          { name: '_k_obj_type_list_end', addr: 0x2098 },
          { name: 'registry', addr: 0x4000, size: 128 * 16, file: 'obj_core.c' },
          { name: 'boot_queue', addr: 0x3000, size: 48 },
          { name: 'alarm_queue', addr: 0x3030, size: 48 },
        ],
        image,
      ),
    )!
    const snapshot = await readObjectCores(meta, gdbstubReader(guest))

    expect(snapshot).toMatchObject({ objectCount: 2, truncated: false })
    expect(snapshot.types[0]).toMatchObject({
      code: 'MSGQ',
      name: 'Message queues',
      objects: [
        { name: 'boot_queue', staticObject: true, capacity: 8, stats: null },
        {
          name: 'alarm_queue',
          staticObject: true,
          capacity: 2,
          fields: [
            { label: 'Message size', value: '16' },
            { label: 'Used messages', value: '0' },
            { label: 'Capacity', value: '2' },
          ],
        },
      ],
    })
  })

  it('says the inventory is incomplete once the registry has dropped objects', async () => {
    const guest = flatGuest()
    guest.u64(0x1000, 0x2000)
    putType(guest, 0x2000, { id: MUTX, coreOffset: 40, dropped: 3 })

    const meta = objectCoreMetaFromImage(
      a53Image(
        [
          { name: 'z_obj_type_list', addr: 0x1000, size: 16 },
          { name: '_k_obj_type_list_start', addr: 0x2000 },
          { name: '_k_obj_type_list_end', addr: 0x2098 },
          { name: 'registry', addr: 0x4000, size: 128 * 16, file: 'obj_core.c' },
        ],
        guest,
      ),
    )!
    const snapshot = await readObjectCores(meta, gdbstubReader(guest))
    expect(snapshot).toMatchObject({ objectCount: 0, truncated: true })
  })
})

describe('message queue ring', () => {
  /*
   * k_msgq as DWARF lays it out. The 8-byte one is the released
   * qemu_cortex_a53 msg_queue image's; the 4-byte one is the same struct on an
   * ILP32 uniprocessor build, where the spinlock is empty.
   */
  const LAYOUTS = {
    4: { wait_q: 0, lock: 8, msg_size: 8, max_msgs: 12, buffer_start: 16, buffer_end: 20, read_ptr: 24, write_ptr: 28, used_msgs: 32, flags: 36 },
    8: { wait_q: 0, lock: 16, msg_size: 16, max_msgs: 24, buffer_start: 32, buffer_end: 40, read_ptr: 48, write_ptr: 56, used_msgs: 64, flags: 68 },
  } as const

  const QUEUE = 0x4000_e160
  const BUFFER = 0x4006_1670

  function ringMeta(ptrBytes: 4 | 8, layout: Record<string, number> = LAYOUTS[ptrBytes]) {
    return { ptrBytes, layouts: { k_msgq: layout } }
  }

  /** A k_msgq struct: `put_front` has just wrapped R to slot 9 of 10. */
  function queueStruct(ptrBytes: 4 | 8): Uint8Array {
    const layout = LAYOUTS[ptrBytes]
    const bytes = new Uint8Array(layout.flags + 4)
    const view = new DataView(bytes.buffer)
    const word = (at: number, value: number) =>
      ptrBytes === 4 ? view.setUint32(at, value, true) : view.setBigUint64(at, BigInt(value), true)
    word(layout.msg_size, 1)
    view.setUint32(layout.max_msgs, 10, true)
    word(layout.buffer_start, BUFFER)
    word(layout.buffer_end, BUFFER + 10)
    word(layout.read_ptr, BUFFER + 9)
    word(layout.write_ptr, BUFFER + 2)
    view.setUint32(layout.used_msgs, 3, true)
    return bytes
  }

  it.each([4, 8] as const)('decodes the ring from a %i-byte-pointer struct', (ptrBytes) => {
    expect(decodeMsgqRing(queueStruct(ptrBytes), ringMeta(ptrBytes))).toEqual({
      msgSize: 1,
      maxMsgs: 10,
      used: 3,
      bufferStart: BUFFER,
      bufferEnd: BUFFER + 10,
      readPtr: BUFFER + 9,
      writePtr: BUFFER + 2,
    })
  })

  it('reads a 64-bit pointer whole, not its low word', () => {
    const bytes = queueStruct(8)
    new DataView(bytes.buffer).setBigUint64(LAYOUTS[8].read_ptr, 0x1_4006_1679n, true)
    expect(decodeMsgqRing(bytes, ringMeta(8))!.readPtr).toBe(0x1_4006_1679)
  })

  it.each([4, 8] as const)('reads the struct and then its buffer, %i-byte pointers', async (ptrBytes) => {
    const mem = new Map<number, Uint8Array>([
      [QUEUE, queueStruct(ptrBytes)],
      [BUFFER, new TextEncoder().encode('01\0\0\0\0\0\0\0A')],
    ])
    const reads: Array<[number, number]> = []
    const reader = memoryReader(mem)
    const snapshot = await readMsgqRing(ringMeta(ptrBytes), QUEUE, (addr, length) => {
      reads.push([addr, length])
      return reader(addr, length)
    })
    // Just the ring members (through used_msgs), then exactly the buffer.
    expect(reads).toEqual([
      [QUEUE, LAYOUTS[ptrBytes].used_msgs + 4],
      [BUFFER, 10],
    ])
    expect(snapshot).toMatchObject({ used: 3, readPtr: BUFFER + 9, writePtr: BUFFER + 2 })
    expect(new TextDecoder().decode(snapshot!.bytes!)).toBe('01\0\0\0\0\0\0\0A')
  })

  it('caps the buffer read', async () => {
    const bytes = queueStruct(4)
    const view = new DataView(bytes.buffer)
    view.setUint32(LAYOUTS[4].msg_size, 64, true)
    view.setUint32(LAYOUTS[4].max_msgs, 32, true)
    view.setUint32(LAYOUTS[4].buffer_end, BUFFER + 64 * 32, true)
    view.setUint32(LAYOUTS[4].read_ptr, BUFFER, true)
    view.setUint32(LAYOUTS[4].write_ptr, BUFFER + 64 * 3, true)
    const snapshot = await readMsgqRing(ringMeta(4), QUEUE, memoryReader(new Map([[QUEUE, bytes]])))
    expect(snapshot!.bytes).toHaveLength(1024)
  })

  it('keeps the ring when only the buffer will not read', async () => {
    const snapshot = await readMsgqRing(ringMeta(4), QUEUE, async (addr, length) =>
      addr === QUEUE ? queueStruct(4).subarray(0, length) : null,
    )
    expect(snapshot).toMatchObject({ used: 3, bytes: null })
  })

  it('has no ring when DWARF does not name every member, and reads nothing', async () => {
    const { read_ptr: _dropped, ...partial } = LAYOUTS[8]
    const reads: number[] = []
    const snapshot = await readMsgqRing(ringMeta(8, partial), QUEUE, async (addr) => {
      reads.push(addr)
      return null
    })
    expect(snapshot).toBeNull()
    expect(reads).toEqual([])
    expect(decodeMsgqRing(queueStruct(8), ringMeta(8, partial))).toBeNull()
  })

  it('has no ring for a struct that is not one, or one that will not read', async () => {
    // All zeros: a queue k_msgq_init() has not reached, or not a queue at all.
    const zeros = await readMsgqRing(ringMeta(4), QUEUE, async (_addr, length) => new Uint8Array(length))
    expect(zeros).toBeNull()
    const faulted = await readMsgqRing(ringMeta(4), QUEUE, async () => {
      throw new Error('E14')
    })
    expect(faulted).toBeNull()
    // Too short to hold the members: the decoder will not guess at the rest.
    expect(decodeMsgqRing(queueStruct(4).subarray(0, 20), ringMeta(4))).toBeNull()
  })
})
