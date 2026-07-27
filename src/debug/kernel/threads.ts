/**
 * Walk Zephyr `_kernel.threads` using CONFIG_DEBUG_THREAD_INFO offsets.
 *
 * Mirrors OpenOCD src/rtos/zephyr.c: start at `_kernel + K_THREADS`, follow
 * `T_NEXT_THREAD`, read name / prio / state from each TCB.
 *
 * Stack bounds (host-only, no guest Kconfig change required):
 *   1. Prefer `stack_info` via DWARF offsetof when the ELF has it
 *   2. Else match SP (T_STACK_PTR) against ELF stack object symbols
 */

import {
  off,
  ThreadInfoOffset,
  type ThreadInfo,
} from '@/debug/kernel/meta'
import { findStackRegion, type StackRegion } from '@/debug/elfStacks'

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
}

export type MemReader = (addr: number, length: number) => Promise<Uint8Array>

export interface ListThreadsOptions {
  /** ELF stack objects for SP→region matching. */
  stacks?: StackRegion[]
  limit?: number
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

/** Zephyr `_thread_base.thread_state` bits → short label. */
export function threadStateLabel(state: number | null, current: boolean): string {
  if (current) return 'running'
  if (state === null) return ''
  // include/zephyr/kernel_structs.h
  if (state & 0x08) return 'dead'
  if (state & 0x10) return 'suspended'
  if (state & 0x02) return 'pending'
  if (state & 0x04) return 'prestart'
  if (state & 0x80) return 'ready'
  if (state & 0x01) return 'dummy'
  return 'active'
}

export function formatStackSize(bytes: number): string {
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function plausibleStack(start: number, size: number): boolean {
  if (!start || size < 64 || size > 512 * 1024) return false
  // Reject obviously non-RAM pointers (null page / flash-ish on Cortex-M).
  if (start < 0x1000) return false
  return true
}

export async function listThreads(
  info: ThreadInfo,
  read: MemReader,
  options: ListThreadsOptions | number = {},
): Promise<ZephyrThread[]> {
  // Back-compat: older tests passed `limit` as the third arg.
  const opts: ListThreadsOptions =
    typeof options === 'number' ? { limit: options } : options
  const limit = opts.limit ?? 64
  const stacks = opts.stacks ?? []

  const threadsOff = off(info, ThreadInfoOffset.K_THREADS)
  const nextOff = off(info, ThreadInfoOffset.T_NEXT_THREAD)
  if (threadsOff === null || nextOff === null) return []

  const ptr = info.ptrBytes
  const head = readPtr(await read(info.kernel + threadsOff, ptr), ptr)

  let current = 0
  const currOff = off(info, ThreadInfoOffset.K_CURR_THREAD)
  if (currOff !== null) {
    try {
      // K_CURR_THREAD is offsetof(_cpu, current); cpus[0] is at _kernel+0.
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
        /* fall through to ELF match */
      }
    }

    if ((stackStart === null || stackSize === null) && sp !== null && stacks.length) {
      const region = findStackRegion(stacks, sp)
      if (region) {
        stackStart = region.addr
        stackSize = region.size
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
    })

    try {
      node = readPtr(await read(node + nextOff, ptr), ptr)
    } catch {
      break
    }
  }
  return out
}
