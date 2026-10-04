import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectCoreMeta } from '@/debug/kernel/objectCores'
import type { StopFilter } from '@/hostGdb'

/*
 * `objects:` with a ring view is the one part of an objects card read at the
 * stop itself rather than from the debugger's walk. These pin that: the ring is
 * read while the machine is halted, stays with the card, and is simply absent
 * (the card keeps its rows) when the image cannot say how to read one.
 */

const QUEUE = 0x4000_e160
const BUFFER = 0x4006_1670

/** k_msgq on the released qemu_cortex_a53 image. */
const A53_MSGQ = {
  wait_q: 0,
  lock: 16,
  msg_size: 16,
  max_msgs: 24,
  buffer_start: 32,
  buffer_end: 40,
  read_ptr: 48,
  write_ptr: 56,
  used_msgs: 64,
  flags: 68,
  obj_core: 72,
}

let meta: Pick<ObjectCoreMeta, 'ptrBytes' | 'layouts'> | null = null
/** Guest memory by exact address, as the stub would return it. */
const memory = new Map<number, Uint8Array>()
const reads: Array<[number, number]> = []
let paused = false
let pc = '00008000'
let gdbListeners: Array<() => void> = []
let stopFilter: StopFilter | null = null

vi.mock('@/hostGdb', () => ({
  subscribe: (fn: () => void) => {
    gdbListeners.push(fn)
    return () => {
      gdbListeners = gdbListeners.filter((f) => f !== fn)
    }
  },
  getSnapshot: () => ({
    attached: true,
    paused,
    pc,
    registers: 'PC=00008000',
    registersLoading: false,
    regArch: 'aarch64' as const,
  }),
  getKernelElf: () => null,
  getSymbolIndex: () => ({
    byAddr: [{ name: 'producer_function', addr: 0x8000, size: 0x40 }],
    byName: [{ name: 'producer_function', addr: 0x8000, size: 0x40 }],
    objects: new Map([['my_msgq', { name: 'my_msgq', addr: QUEUE, size: 96 }]]),
  }),
  getObjectCoreMeta: () => meta,
  setAttachHook: () => {},
  setStopFilter: (fn: StopFilter | null) => {
    stopFilter = fn
  },
  sessionActive: () => true,
}))

vi.mock('@/debug/control', () => ({
  subscribe: () => () => {},
  getSnapshot: () => ({ paused }),
  addBreakpoint: async () => true,
  removeBreakpoint: async () => true,
  readMemory: async () => null,
  readMemoryRaw: async (addr: number, length: number) => {
    reads.push([addr, length])
    // Like the stub: nothing to read while the guest runs.
    if (!paused) return null
    return memory.get(addr)?.slice(0, length) ?? null
  },
  resume: () => {
    paused = false
    for (const fn of gdbListeners) fn()
  },
}))

const tourText = vi.hoisted(() => ({ body: '' }))

vi.mock('@/tours/catalog', () => ({
  loadTourSource: async (id: string) => (id.startsWith('ring-') ? tourText.body : null),
  hasTour: () => true,
  tourIds: () => ['ring'],
  baseSampleId: (id: string) => id,
}))

vi.mock('@/lib/dockReveal', () => ({ revealPanelKind: () => {}, revealDockRow: () => {} }))

const { arm, getSnapshot, loadFor, next, reset, revisit } = await import('@/tours/store')

function tour(view: string) {
  return `---
tour: Ring test
sample: samples/kernel/msg_queue
---

## The urgent message goes in front

\`\`\`tour
at: 0x8000
objects:
  type: msgq
  focus: my_msgq
${view}
\`\`\`

Prose.

## Later

\`\`\`tour
at: 0x9000
\`\`\`

Prose.
`
}

/** my_msgq right after the first put_front: R wrapped to slot 9. */
function queueAfterPutFront(): Uint8Array {
  const bytes = new Uint8Array(96)
  const view = new DataView(bytes.buffer)
  view.setBigUint64(A53_MSGQ.msg_size, 1n, true)
  view.setUint32(A53_MSGQ.max_msgs, 10, true)
  view.setBigUint64(A53_MSGQ.buffer_start, BigInt(BUFFER), true)
  view.setBigUint64(A53_MSGQ.buffer_end, BigInt(BUFFER + 10), true)
  view.setBigUint64(A53_MSGQ.read_ptr, BigInt(BUFFER + 9), true)
  view.setBigUint64(A53_MSGQ.write_ptr, BigInt(BUFFER + 2), true)
  view.setUint32(A53_MSGQ.used_msgs, 3, true)
  return bytes
}

async function stopAt(addr: number) {
  const hex = addr.toString(16).padStart(8, '0')
  // No step here has a state predicate, so the stop's own registers and memory go unread.
  if (await stopFilter?.({ pc: hex, registers: '', read: async () => null })) return
  paused = true
  pc = hex
  for (const fn of gdbListeners) fn()
  await new Promise((r) => setTimeout(r, 0))
}

let id = 0

async function start(view: string) {
  tourText.body = tour(view)
  await loadFor(`ring-${id++}`)
  await arm()
}

beforeEach(() => {
  reset()
  paused = false
  stopFilter = null
  reads.length = 0
  meta = { ptrBytes: 8, layouts: { k_msgq: A53_MSGQ } }
  memory.clear()
  memory.set(QUEUE, queueAfterPutFront())
  memory.set(BUFFER, new TextEncoder().encode('01\0\0\0\0\0\0\0A'))
})

describe('a ring view', () => {
  it('reads the queue and its buffer while the machine is halted', async () => {
    await start('  view: ring')
    await stopAt(0x8000)
    const objects = getSnapshot().current?.objects
    expect(objects).toMatchObject({ types: ['MSGQ'], focus: QUEUE })
    expect(objects?.ring).toMatchObject({ msgSize: 1, maxMsgs: 10, used: 3, readPtr: BUFFER + 9 })
    expect(new TextDecoder().decode(objects!.ring!.bytes!)).toBe('01\0\0\0\0\0\0\0A')
    // The struct through used_msgs, then the buffer: two reads, both at the stop.
    expect(reads).toEqual([
      [QUEUE, A53_MSGQ.used_msgs + 4],
      [BUFFER, 10],
    ])
  })

  it('keeps the ring it read, so a revisit shows the step it belongs to', async () => {
    await start('  view: ring')
    await stopAt(0x8000)
    next()
    await new Promise((r) => setTimeout(r, 0))
    // The consumer has drained the queue by the next stop.
    const drained = queueAfterPutFront()
    new DataView(drained.buffer).setUint32(A53_MSGQ.used_msgs, 0, true)
    memory.set(QUEUE, drained)
    await stopAt(0x9000)
    revisit(0)
    expect(getSnapshot().current?.objects?.ring).toMatchObject({ used: 3, readPtr: BUFFER + 9 })
  })

  it('is what a step about one queue gets by default', async () => {
    await start('')
    await stopAt(0x8000)
    expect(getSnapshot().current?.objects?.ring).toMatchObject({ used: 3 })
  })

  it('reads nothing for `view: list`', async () => {
    await start('  view: list')
    await stopAt(0x8000)
    expect(getSnapshot().current?.objects).toEqual({ types: ['MSGQ'], focus: QUEUE, ring: null })
    expect(reads).toEqual([])
  })

  it('leaves the card its rows when the image cannot say how to read a ring', async () => {
    // No object cores at all…
    meta = null
    await start('  view: ring')
    await stopAt(0x8000)
    expect(getSnapshot().current?.objects).toEqual({ types: ['MSGQ'], focus: QUEUE, ring: null })

    // …or DWARF that does not name the pointers.
    reset()
    const { read_ptr: _dropped, ...partial } = A53_MSGQ
    meta = { ptrBytes: 8, layouts: { k_msgq: partial } }
    await start('  view: ring')
    await stopAt(0x8000)
    expect(getSnapshot().current?.objects).toEqual({ types: ['MSGQ'], focus: QUEUE, ring: null })
    expect(reads).toEqual([])
  })
})
