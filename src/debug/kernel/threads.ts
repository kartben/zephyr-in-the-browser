/**
 * Walk Zephyr `_kernel.threads` using CONFIG_DEBUG_THREAD_INFO offsets.
 *
 * Mirrors OpenOCD src/rtos/zephyr.c: start at `_kernel + K_THREADS`, follow
 * `T_NEXT_THREAD`, read name / prio / state from each TCB.
 *
 * Stack bounds (host-only):
 *   1. Prefer `stack_info` via DWARF offsetof when the ELF has it
 *   2. Else match SP (T_STACK_PTR) against ELF stack object symbols
 *
 * Wait target (host-only): read `base.pended_on` and match to ELF symbols.
 */

import {
  off,
  ThreadInfoOffset,
  type ThreadInfo,
} from '@/debug/kernel/meta'
import { findStackRegion, type StackRegion } from '@/debug/elfStacks'
import { findWaitObject, type WaitObject } from '@/debug/elfWaitObjects'

/** Zephyr thread_state bits — include/zephyr/kernel_structs.h */
const ST_DUMMY = 0x01
const ST_PENDING = 0x02
const ST_SLEEPING = 0x04
const ST_DEAD = 0x08
const ST_SUSPENDED = 0x10
const ST_ABORTING = 0x20
const ST_SUSPENDING = 0x40
const ST_QUEUED = 0x80

export interface ZephyrThread {
  addr: number
  name: string
  entry: number | null
  prio: number | null
  state: number | null
  current: boolean
  /** Saved stack pointer, when T_STACK_PTR is available. */
  sp: number | null
  /** Stack buffer base (low address). */
  stackStart: number | null
  /** Stack buffer size in bytes. */
  stackSize: number | null
  /** `base.pended_on` wait-queue pointer, when readable. */
  pendedOn: number | null
  /** Named object for pendedOn, when matched in the ELF. */
  waitingOn: { name: string; addr: number; kind: string | null } | null
}

export type MemReader = (addr: number, length: number) => Promise<Uint8Array>

export interface ListThreadsOptions {
  /** ELF stack objects for SP→region matching. */
  stacks?: StackRegion[]
  /** ELF sync objects for pended_on→name matching. */
  waitObjects?: WaitObject[]
  limit?: number
}

export interface ThreadStatus {
  /** Short primary label: running / ready / sleeping / waiting / … */
  label: string
  /** Extra line, e.g. object name when waiting. */
  detail: string | null
  /** Address to peek for the wait object, if any. */
  detailAddr: number | null
}

function u32(bytes: Uint8Array, at = 0): number {
  return (
    (bytes[at]! |
      (bytes[at + 1]! << 8) |
      (bytes[at + 2]! << 16) |
      (bytes[at + 3]! << 24)) >>>
    0
  )
}

function readPtr(bytes: Uint8Array, ptrBytes: 4 | 8): number {
  if (ptrBytes === 4) return u32(bytes, 0)
  return u32(bytes, 0) + u32(bytes, 4) * 0x1_0000_0000
}

function decodeCString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0)
  if (end < 0) end = bytes.length
  let out = ''
  for (let i = 0; i < end; i++) {
    const c = bytes[i]!
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
  }
  return out
}

/**
 * Human-readable status for the Threads list — keep labels short; put the
 * wait target in `detail` so the UI can show it on its own line.
 */
export function describeThreadStatus(
  t: Pick<ZephyrThread, 'state' | 'current' | 'waitingOn' | 'pendedOn'>,
): ThreadStatus {
  if (t.current) return { label: 'running', detail: null, detailAddr: null }

  const state = t.state
  if (state === null) return { label: '', detail: null, detailAddr: null }

  if (state & ST_DEAD) return { label: 'dead', detail: null, detailAddr: null }
  if (state & ST_ABORTING) return { label: 'aborting', detail: null, detailAddr: null }
  if (state & ST_SUSPENDED || state & ST_SUSPENDING) {
    return { label: 'suspended', detail: null, detailAddr: null }
  }

  if (state & ST_PENDING) {
    if (t.waitingOn) {
      const kind = t.waitingOn.kind
      const name = t.waitingOn.name
      return {
        label: 'waiting',
        detail: kind ? `${kind} ${name}` : name,
        detailAddr: t.waitingOn.addr,
      }
    }
    // Pending with no resolvable wait object — don't invent a label.
    if (state & ST_SLEEPING) {
      return { label: 'sleeping', detail: null, detailAddr: null }
    }
    return { label: 'waiting', detail: null, detailAddr: null }
  }

  if (state & ST_SLEEPING) return { label: 'sleeping', detail: null, detailAddr: null }
  if (state & ST_QUEUED) return { label: 'ready', detail: null, detailAddr: null }
  if (state & ST_DUMMY) return { label: 'dummy', detail: null, detailAddr: null }
  return { label: 'active', detail: null, detailAddr: null }
}

export function formatStackSize(bytes: number): string {
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function plausibleStack(start: number, size: number): boolean {
  if (!start || size < 64 || size > 512 * 1024) return false
  if (start < 0x1000) return false
  return true
}

export async function listThreads(
  info: ThreadInfo,
  read: MemReader,
  options: ListThreadsOptions | number = {},
): Promise<ZephyrThread[]> {
  const opts: ListThreadsOptions =
    typeof options === 'number' ? { limit: options } : options
  const limit = opts.limit ?? 64
  const stacks = opts.stacks ?? []
  const waitObjects = opts.waitObjects ?? []

  const threadsOff = off(info, ThreadInfoOffset.K_THREADS)
  const nextOff = off(info, ThreadInfoOffset.T_NEXT_THREAD)
  if (threadsOff === null || nextOff === null) return []

  const ptr = info.ptrBytes
  const head = readPtr(await read(info.kernel + threadsOff, ptr), ptr)

  let current = 0
  const currOff = off(info, ThreadInfoOffset.K_CURR_THREAD)
  if (currOff !== null) {
    try {
      current = readPtr(await read(info.kernel + currOff, ptr), ptr)
    } catch {
      current = 0
    }
  }

  const nameOff = off(info, ThreadInfoOffset.T_NAME)
  const entryOff = off(info, ThreadInfoOffset.T_ENTRY)
  const prioOff = off(info, ThreadInfoOffset.T_PRIO)
  const stateOff = off(info, ThreadInfoOffset.T_STATE)
  const spLocOff = off(info, ThreadInfoOffset.T_STACK_PTR)
  const stackInfoOff = info.stackInfoOff
  const pendedOnOff = info.pendedOnOff

  const out: ZephyrThread[] = []
  const seen = new Set<number>()
  let node = head
  while (node && out.length < limit) {
    if (seen.has(node)) break
    seen.add(node)

    let name = ''
    if (nameOff !== null) {
      try {
        name = decodeCString(await read(node + nameOff, 32))
      } catch {
        name = ''
      }
    }

    let entry: number | null = null
    if (entryOff !== null) {
      try {
        entry = readPtr(await read(node + entryOff, ptr), ptr)
      } catch {
        entry = null
      }
    }
    if (!name) {
      name =
        entry != null
          ? `thr_${entry.toString(16)}_${node.toString(16)}`
          : `thread@${node.toString(16)}`
    }

    let prio: number | null = null
    if (prioOff !== null) {
      try {
        prio = (await read(node + prioOff, 1))[0]!
        if (prio > 127) prio -= 256
      } catch {
        prio = null
      }
    }

    let state: number | null = null
    if (stateOff !== null) {
      try {
        state = (await read(node + stateOff, 1))[0]!
      } catch {
        state = null
      }
    }

    let sp: number | null = null
    if (spLocOff !== null) {
      try {
        sp = readPtr(await read(node + spLocOff, ptr), ptr)
        if (!sp) sp = null
      } catch {
        sp = null
      }
    }

    let stackStart: number | null = null
    let stackSize: number | null = null

    if (stackInfoOff !== null) {
      try {
        const base = node + stackInfoOff
        const start = readPtr(await read(base, ptr), ptr)
        const size = readPtr(await read(base + ptr, ptr), ptr)
        if (plausibleStack(start, size)) {
          stackStart = start
          stackSize = size
        }
      } catch {
        /* fall through */
      }
    }

    if ((stackStart === null || stackSize === null) && sp !== null && stacks.length) {
      const region = findStackRegion(stacks, sp)
      if (region) {
        stackStart = region.addr
        stackSize = region.size
      }
    }

    let pendedOn: number | null = null
    let waitingOn: ZephyrThread['waitingOn'] = null
    if (pendedOnOff !== null && state !== null && state & ST_PENDING) {
      try {
        const q = readPtr(await read(node + pendedOnOff, ptr), ptr)
        if (q) {
          pendedOn = q
          // Another thread's join_queue lives inside that TCB.
          const joined = out.find(
            (o) => q >= o.addr && q < o.addr + 512,
          )
          if (joined) {
            waitingOn = { name: joined.name, addr: joined.addr, kind: 'join' }
          } else {
            const obj = findWaitObject(waitObjects, q)
            if (obj) waitingOn = { name: obj.name, addr: obj.addr, kind: obj.kind }
          }
        }
      } catch {
        /* leave null */
      }
    }

    out.push({
      addr: node,
      name,
      entry,
      prio,
      state,
      current: current !== 0 && node === current,
      sp,
      stackStart,
      stackSize,
      pendedOn,
      waitingOn,
    })

    try {
      node = readPtr(await read(node + nextOff, ptr), ptr)
    } catch {
      break
    }
  }

  // Second pass: join targets that appear later in the list.
  for (const t of out) {
    if (t.waitingOn || !t.pendedOn) continue
    if (t.state === null || !(t.state & ST_PENDING)) continue
    const joined = out.find(
      (o) => o.addr !== t.addr && t.pendedOn! >= o.addr && t.pendedOn! < o.addr + 512,
    )
    if (joined) {
      t.waitingOn = { name: joined.name, addr: joined.addr, kind: 'join' }
    }
  }

  return out
}
