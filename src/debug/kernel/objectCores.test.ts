import { describe, expect, it } from 'vitest'
import {
  readObjectCores,
  type ObjectCoreMeta,
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

function put32(bytes: Uint8Array, at: number, value: number) {
  new DataView(bytes.buffer).setUint32(at, value, true)
}

describe('object core walk', () => {
  it('seeds static objects from descriptors before live lists are initialized', async () => {
    const meta: ObjectCoreMeta = {
      ptrBytes: 4,
      typeListAddr: 0x0800,
      descriptorStart: 0x1000,
      descriptorEnd: 0x1018,
      descriptorSize: 24,
      statsEnabled: false,
      typeMembers: { node: 0, list: 4, id: 12, obj_core_offset: 16 },
      coreMembers: { node: 0, type: 4 },
      layouts: {
        k_msgq: { msg_size: 0, max_msgs: 8, used_msgs: 12, obj_core: 16 },
        k_mem_slab_info: {},
        sys_mem_blocks_info: {},
        k_cycle_stats: {},
      },
      symbols: [{ name: 'boot_queue', addr: 0x3000, size: 32, type: 1 }],
    }
    const mem = new Map<number, Uint8Array>()
    mem.set(0x0800, new Uint8Array(4)) // z_obj_type_list not linked yet

    const desc = new Uint8Array(24)
    for (const [at, value] of [
      [0, 0x2000],
      [4, 0x3000],
      [8, 0x3020],
      [12, 16],
      [16, 32],
      [20, 0x4d534751],
    ]) {
      put32(desc, at, value)
    }
    mem.set(0x1000, desc)

    const msgq = new Uint8Array(32)
    put32(msgq, 0, 4)
    put32(msgq, 8, 8)
    put32(msgq, 12, 0)
    mem.set(0x3000, msgq)

    const snapshot = await readObjectCores(meta, memoryReader(mem))
    expect(snapshot).toMatchObject({ objectCount: 1, truncated: false })
    expect(snapshot.types[0]).toMatchObject({
      code: 'MSGQ',
      objectSize: 32,
      objects: [
        {
          name: 'boot_queue',
          addr: 0x3000,
          capacity: 8,
          staticObject: true,
        },
      ],
    })
  })

  it('uses descriptors for a typed live object inventory', async () => {
    const meta: ObjectCoreMeta = {
      ptrBytes: 4,
      typeListAddr: 0x0800,
      descriptorStart: 0x1000,
      descriptorEnd: 0x1018,
      descriptorSize: 24,
      statsEnabled: false,
      typeMembers: { node: 0, list: 4, id: 12, obj_core_offset: 16 },
      coreMembers: { node: 0, type: 4 },
      layouts: {
        k_sem: { count: 0, limit: 4, obj_core: 8 },
        k_mem_slab_info: {},
        sys_mem_blocks_info: {},
        k_cycle_stats: {},
      },
      symbols: [{ name: 'uart_sem', addr: 0x3000, size: 16, type: 1 }],
    }
    const mem = new Map<number, Uint8Array>()

    const list = new Uint8Array(4)
    put32(list, 0, 0x2000)
    mem.set(0x0800, list)

    // k_obj_core_desc: type, static start/end, core offset, object size, SEM4.
    const desc = new Uint8Array(24)
    for (const [at, value] of [
      [0, 0x2000],
      [4, 0x3000],
      [8, 0x3010],
      [12, 8],
      [16, 16],
      [20, 0x53454d34],
    ]) {
      put32(desc, at, value)
    }
    mem.set(0x1000, desc)

    // k_obj_type: next type, object-list head/tail, id, obj_core_offset.
    const type = new Uint8Array(20)
    put32(type, 4, 0x3008)
    put32(type, 8, 0x3008)
    put32(type, 12, 0x53454d34)
    put32(type, 16, 8)
    mem.set(0x2000, type)

    const sem = new Uint8Array(16)
    put32(sem, 0, 2)
    put32(sem, 4, 5)
    put32(sem, 12, 0x2000) // obj_core.type
    mem.set(0x3000, sem)

    const snapshot = await readObjectCores(meta, memoryReader(mem))
    expect(snapshot).toMatchObject({ objectCount: 1, statsCount: 0, truncated: false })
    expect(snapshot.types[0]).toMatchObject({
      code: 'SEM4',
      name: 'Semaphores',
      objectSize: 16,
    })
    expect(snapshot.types[0]!.objects[0]).toMatchObject({
      name: 'uart_sem',
      addr: 0x3000,
      coreAddr: 0x3008,
      capacity: 5,
      staticObject: true,
      fields: [
        { label: 'Count', value: '2' },
        { label: 'Limit', value: '5' },
      ],
    })
  })

  it('reads raw object-core statistics when enabled', async () => {
    const meta: ObjectCoreMeta = {
      ptrBytes: 4,
      typeListAddr: 0x0800,
      descriptorStart: 0x1000,
      descriptorEnd: 0x1024,
      descriptorSize: 36,
      statsEnabled: true,
      typeMembers: {
        node: 0,
        list: 4,
        id: 12,
        obj_core_offset: 16,
        stats_desc: 20,
      },
      coreMembers: { node: 0, type: 4, stats: 8 },
      layouts: {
        k_thread: { obj_core: 16 },
        k_mem_slab_info: {},
        sys_mem_blocks_info: {},
        k_cycle_stats: { total: 0, track_usage: 8 },
      },
      symbols: [{ name: 'worker_thread', addr: 0x3000, size: 28, type: 1 }],
    }
    const mem = new Map<number, Uint8Array>()
    const list = new Uint8Array(4)
    put32(list, 0, 0x2000)
    mem.set(0x0800, list)

    const desc = new Uint8Array(36)
    for (const [at, value] of [
      [0, 0x2000],
      [12, 16],
      [16, 28],
      [20, 0x54485244],
      [24, 0x4000],
    ]) {
      put32(desc, at, value)
    }
    mem.set(0x1000, desc)

    const type = new Uint8Array(24)
    put32(type, 4, 0x3010)
    put32(type, 8, 0x3010)
    put32(type, 12, 0x54485244)
    put32(type, 16, 16)
    put32(type, 20, 0x4000)
    mem.set(0x2000, type)

    const thread = new Uint8Array(28)
    put32(thread, 20, 0x2000)
    put32(thread, 24, 0x5000)
    mem.set(0x3000, thread)

    const statsDesc = new Uint8Array(8)
    put32(statsDesc, 0, 12)
    put32(statsDesc, 4, 24)
    mem.set(0x4000, statsDesc)
    const stats = new Uint8Array(12)
    new DataView(stats.buffer).setBigUint64(0, 123456n, true)
    stats[8] = 1
    mem.set(0x5000, stats)

    const snapshot = await readObjectCores(meta, memoryReader(mem))
    expect(snapshot.statsCount).toBe(1)
    expect(snapshot.types[0]!.objects[0]!.stats).toMatchObject({
      addr: 0x5000,
      rawSize: 12,
      querySize: 24,
      fields: [
        { label: 'Total cycles', value: '123,456' },
        { label: 'Collection', value: 'enabled' },
      ],
    })
  })
})
