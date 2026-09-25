import { describe, expect, it } from 'vitest'

import {
  buildStructure,
  kernelObjects,
  membersOf,
  roleOf,
  type ListInfo,
  type MemberInfo,
} from './memoryStructure'
import { explainList, explainMember } from './memoryExplain'
import type { AddressMap, ResolvedAddress } from '@/debug/addressMap'
import type {
  KernelLayouts,
  ObjectCoreSnapshot,
  ZephyrKernelObject,
} from '@/debug/kernel/objectCores'
import type { ZephyrThread } from '@/debug/kernel/threads'

/** The aarch64 shell image's layouts, as DWARF reports them. */
const LAYOUTS: KernelLayouts = {
  ptrBytes: 8,
  structs: {
    k_sem: { wait_q: 0, count: 16, limit: 20, obj_core: 24 },
    k_event: { wait_q: 0, events: 16, lock: 20, obj_core: 24 },
    k_thread: { base: 0, callee_saved: 88, join_queue: 208, obj_core: 360 },
    _thread_base: { pended_on: 16, user_options: 24, thread_state: 28, swap_data: 32 },
  },
  core: { node: 0, type: 8, stats: 16 },
}

const EVENT = 0x4005_bcf0
const SEM = 0x4005_bd20
const NEXT_SEM_CORE = 0x4005_f408
const THREAD = 0x4005_b660
const OBJ_TYPE_SEM = 0x4006_0c58

function object(
  addr: number,
  typeCode: string,
  name: string,
  size: number,
): ZephyrKernelObject {
  return {
    addr,
    coreAddr: addr + 24,
    typeAddr: 0,
    typeId: 0,
    typeCode,
    typeName: typeCode,
    name,
    size,
    capacity: null,
    staticObject: true,
    fields: [],
    stats: null,
  }
}

const OBJECTS: ObjectCoreSnapshot = {
  types: [
    {
      addr: 1,
      id: 1,
      code: 'EVNT',
      name: 'Events',
      objectSize: 48,
      objects: [object(EVENT, 'EVNT', 'shell_uart_ctx+0x2d0', 48)],
    },
    {
      addr: 2,
      id: 2,
      code: 'SEM4',
      name: 'Semaphores',
      objectSize: 48,
      objects: [object(SEM, 'SEM4', 'shell_uart_ctx+0x300', 48)],
    },
    {
      addr: 3,
      id: 3,
      code: 'THRD',
      name: 'Threads',
      objectSize: 960,
      objects: [object(THREAD, 'THRD', 'shell_uart_thread', 960)],
    },
  ],
  objectCount: 3,
  statsCount: 0,
  truncated: false,
}

const NAMED: Record<number, ResolvedAddress> = {
  [THREAD]: { kind: 'object', name: 'shell_uart_thread', base: THREAD, offset: 0, size: 960, typeCode: 'THRD' },
  [EVENT]: { kind: 'object', name: 'shell_uart_ctx+0x2d0', base: EVENT, offset: 0, size: 48, typeCode: 'EVNT' },
  [SEM]: { kind: 'object', name: 'shell_uart_ctx+0x300', base: SEM, offset: 0, size: 48, typeCode: 'SEM4' },
  [NEXT_SEM_CORE]: {
    kind: 'objectCore',
    name: 'shell_uart_mpsc_buffer+0x38.obj_core',
    base: NEXT_SEM_CORE,
    offset: 0,
    size: null,
    typeCode: 'SEM4',
  },
  [OBJ_TYPE_SEM]: { kind: 'data', name: 'obj_type_sem', base: OBJ_TYPE_SEM, offset: 0, size: 24 },
}
const map: AddressMap = { empty: false, resolve: (addr) => NAMED[addr] ?? null }

const shellUart = {
  addr: THREAD,
  name: 'shell_uart',
  pendedOn: EVENT,
} as ZephyrThread

/** A window of 64-bit little-endian words and 32-bit halves: `[value, bytes]`. */
function window(parts: Array<[number, 4 | 8]>): Uint8Array {
  const out: number[] = []
  for (const [value, size] of parts) {
    for (let b = 0; b < size; b++) out.push(Math.floor(value / 2 ** (b * 8)) & 0xff)
  }
  return Uint8Array.from(out)
}

/** The screenshot's rows: a k_event with shell_uart waiting, then a k_sem. */
const SCREENSHOT = window([
  [THREAD, 8], // event.wait_q head
  [THREAD, 8], // event.wait_q tail
  [0x8, 4], // event.events
  [0, 4], // event.lock (padding on a UP build)
  [0, 8], // event.obj_core.node.next: last event
  [0x4006_0d58, 8], // event.obj_core.type
  [0, 8], // event.obj_core.stats
  [SEM, 8], // sem.wait_q head: itself
  [SEM, 8], // sem.wait_q tail: itself
  [1, 4], // sem.count
  [1, 4], // sem.limit
  [NEXT_SEM_CORE, 8], // sem.obj_core.node.next
  [OBJ_TYPE_SEM, 8], // sem.obj_core.type
  [0, 8], // sem.obj_core.stats
])

const build = (base: number, bytes: Uint8Array, threads: ZephyrThread[] = [shellUart]) =>
  buildStructure({
    base,
    bytes,
    ptrBytes: 8,
    map,
    threads,
    objects: OBJECTS,
    layouts: LAYOUTS,
    follow: () => {},
  })

const byRole = (notes: ReturnType<typeof build>['notes']) =>
  Object.fromEntries(notes.map((note) => [`${note.offset}:${note.label?.role ?? ''}`, note]))

describe('membersOf', () => {
  const [sem] = kernelObjects(OBJECTS, []).filter((ref) => ref.struct === 'k_sem')

  it('lays a k_sem out member by member, opening up its obj_core', () => {
    expect(membersOf(sem!, LAYOUTS).map((m) => [m.path, m.addr - SEM, m.size, m.kind])).toEqual([
      ['wait_q', 0, 16, 'waitq'],
      ['count', 16, 4, 'number'],
      ['limit', 20, 4, 'number'],
      ['obj_core.node.next', 24, 8, 'next'],
      ['obj_core.type', 32, 8, 'type'],
      ['obj_core.stats', 40, 8, 'pointer'],
    ])
  })

  it("opens a thread's base: its queue node, what it is pended on, its priority", () => {
    const thread = kernelObjects(OBJECTS, []).find((ref) => ref.struct === 'k_thread')!
    const paths = membersOf(thread, LAYOUTS).map((m) => [m.path, m.addr - THREAD, m.kind])
    expect(paths.slice(0, 5)).toEqual([
      ['base.qnode_dlist', 0, 'dnode'],
      ['base.pended_on', 16, 'pointer'],
      ['base.user_options', 24, 'flags'],
      ['base.prio', 26, 'signed'],
      ['base.thread_state', 28, 'flags'],
    ])
  })

  it('drops a zero-size member that shares its offset with the next', () => {
    const up: KernelLayouts = {
      ...LAYOUTS,
      ptrBytes: 4,
      structs: { k_event: { wait_q: 0, events: 8, lock: 12, obj_core: 12 } },
    }
    const event = kernelObjects(OBJECTS, []).find((ref) => ref.struct === 'k_event')!
    expect(membersOf(event, up).map((m) => m.path)).not.toContain('lock')
  })

  it('says roles the short way', () => {
    expect(roleOf({ path: 'obj_core.node.next', addr: 0, size: 8, kind: 'next' })).toBe('.obj_core.next')
    expect(roleOf({ path: 'base.pended_on', addr: 0, size: 8, kind: 'pointer' })).toBe('.pended_on')
  })
})

describe('buildStructure', () => {
  const { notes, sections } = build(EVENT, SCREENSHOT)
  const at = byRole(notes)

  it('starts a section where each object begins', () => {
    expect(sections.map((s) => [s.offset, s.label.badge, s.label.head, s.label.tail, s.detail])).toEqual([
      [0, 'k_event', 'shell_uart_ctx', '+0x2d0', '48 B'],
      [48, 'k_sem', 'shell_uart_ctx', '+0x300', '48 B'],
    ])
  })

  it('reads a wait queue with one thread in it', () => {
    const note = at['0:.wait_q']!
    expect(note.length).toBe(16)
    expect(note.label).toEqual({ role: '.wait_q', badge: '1 waiting', head: 'shell_uart' })
    expect(note.tone).toBe('object')
    const info = note.info as ListInfo
    expect(info.waiters.map((t) => t.name)).toEqual(['shell_uart'])
    expect(explainList(info)).toMatch(/exactly one thread is waiting: shell_uart/)
  })

  it('reads an empty wait queue as empty, not as a pointer to its owner', () => {
    const note = at['48:.wait_q']!
    expect(note.label).toEqual({ role: '.wait_q', head: 'empty' })
    expect(note.tone).toBe('quiet')
    expect(note.mark).toBe('dashed')
    expect(explainList(note.info as ListInfo)).toMatch(
      /k_sem\.wait_q \(sys_dlist_t\) is empty: head and tail both hold 0x4005bd20, the list's own address/,
    )
  })

  it('splits two u32 members sharing a word', () => {
    expect(at['64:.count']!.label).toEqual({ role: '.count', head: '1' })
    expect(at['68:.limit']!.label).toEqual({ role: '.limit', head: '1' })
    expect(at['64:.count']!.length).toBe(4)
  })

  it("says NULL in object core's chain is the end of the list", () => {
    expect(at['24:.obj_core.next']!.label).toEqual({ role: '.obj_core.next', head: 'end of list' })
    expect(explainMember(at['24:.obj_core.next']!.info as MemberInfo)).toBe(
      "k_event.obj_core.node.next is NULL: this is the last k_event on object core's list of them.",
    )
  })

  it("explains that the next link lands on the next object's obj_core", () => {
    const note = at['72:.obj_core.next']!
    expect(note.tone).toBe('quiet')
    expect(explainMember(note.info as MemberInfo)).toMatch(
      /lands on the \.obj_core of the next semaphore, not on its start: subtract 0x18/,
    )
  })

  it('names the type descriptor', () => {
    expect(at['80:.obj_core.type']!.label).toEqual({ role: '.obj_core.type', head: 'obj_type_sem' })
  })

  it('leaves a member cut by the window edge alone', () => {
    const cut = build(EVENT + 8, SCREENSHOT.subarray(8))
    expect(cut.notes.some((note) => note.label?.role === '.wait_q' && note.offset < 8)).toBe(false)
  })

  it('never reads a tree-shaped wait queue as a list', () => {
    const scalable: KernelLayouts = {
      ...LAYOUTS,
      structs: { ...LAYOUTS.structs, k_sem: { wait_q: 0, count: 32, limit: 36, obj_core: 40 } },
    }
    const bytes = window([
      [0, 8],
      [0x4000_1234, 8],
      [0, 8],
      [0, 8],
      [0, 4],
      [0, 4],
    ])
    const { notes } = buildStructure({
      base: SEM,
      bytes,
      ptrBytes: 8,
      map,
      threads: [],
      objects: OBJECTS,
      layouts: scalable,
      follow: () => {},
    })
    const waitq = notes.find((note) => note.label?.role === '.wait_q')!
    expect((waitq.info as ListInfo).shape).toBe('tree')
    expect(waitq.label).toEqual({ role: '.wait_q', head: 'no waiters' })
    expect(explainList(waitq.info as ListInfo)).toMatch(/red-black tree/)
  })

  it("names the member a pointer sits in, for a pointer the layout does not cover", () => {
    const { roleAt } = build(THREAD, new Uint8Array(256))
    expect(roleAt(THREAD + 88 + 0x10)).toBe('.callee_saved+0x10')
  })
})
