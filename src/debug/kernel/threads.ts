/**
 * Walk Zephyr `_kernel.threads` using CONFIG_DEBUG_THREAD_INFO offsets.
 *
 * Mirrors OpenOCD src/rtos/zephyr.c: start at `_kernel + K_THREADS`, follow
 * `T_NEXT_THREAD`, read name / prio / state from each TCB.
 */

import {
  off,
  ThreadInfoOffset,
  type ThreadInfo,
} from '@/debug/kernel/meta'

export interface ZephyrThread {
  addr: number
  name: string
  entry: number | null
  prio: number | null
  state: number | null
  current: boolean
}

export type MemReader = (addr: number, length: number) => Promise<Uint8Array>

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

export async function listThreads(
  info: ThreadInfo,
  read: MemReader,
  limit = 64,
): Promise<ZephyrThread[]> {
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

    out.push({
      addr: node,
      name,
      entry,
      prio,
      state,
      current: current !== 0 && node === current,
    })

    try {
      node = readPtr(await read(node + nextOff, ptr), ptr)
    } catch {
      break
    }
  }
  return out
}
