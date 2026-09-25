/**
 * Zephyr sys_dlist decode (include/zephyr/sys/dlist.h).
 *
 * List and node share `_dnode` ({ next/head, prev/tail }). The list struct sits
 * in the ring; empty ⟺ both fields equal the list address.
 */

import {
  MAX_WALK_NODES,
  type MemoryReader,
  type PtrWidth,
  looksLikePtr,
  readBytes,
  readPtr,
} from '@/debug/ds/mem'

export interface DListHeader {
  addr: number
  head: number
  tail: number
  empty: boolean
}

export interface DListWalk {
  header: DListHeader
  /** Node addresses in order, excluding the list sentinel. */
  nodes: number[]
  truncated: boolean
  error: string | null
}

export function dlistHeaderSize(width: PtrWidth): number {
  return width * 2
}

export function parseDListHeader(bytes: Uint8Array, addr: number, width: PtrWidth): DListHeader {
  const head = readPtr(bytes, 0, width)
  const tail = readPtr(bytes, width, width)
  const self = addr >>> 0
  const empty = head === self && tail === self
  return { addr: self, head, tail, empty }
}

export async function loadDList(
  read: MemoryReader,
  addr: number,
  width: PtrWidth,
  maxNodes = MAX_WALK_NODES,
): Promise<DListWalk> {
  const self = addr >>> 0
  const hb = await readBytes(read, self, dlistHeaderSize(width))
  if (!hb || hb.length < dlistHeaderSize(width)) {
    return {
      header: { addr: self, head: 0, tail: 0, empty: false },
      nodes: [],
      truncated: false,
      error: 'could not read sys_dlist',
    }
  }
  const header = parseDListHeader(hb, self, width)
  if (header.empty) {
    return { header, nodes: [], truncated: false, error: null }
  }
  if (!looksLikePtr(header.head, width)) {
    return { header, nodes: [], truncated: false, error: 'head does not look like a pointer' }
  }

  // Walk via next, stopping when we return to the sentinel.
  const nodes: number[] = []
  const seen = new Set<number>([self])
  let cur = header.head >>> 0
  let truncated = false
  let error: string | null = null

  while (cur && cur !== self) {
    if (seen.has(cur)) {
      error = 'cycle before sentinel'
      break
    }
    seen.add(cur)
    if (nodes.length >= maxNodes) {
      truncated = true
      break
    }
    nodes.push(cur)
    const nb = await readBytes(read, cur, width * 2)
    if (!nb || nb.length < width) {
      error = `failed to read dnode @ ${cur.toString(16)}`
      break
    }
    const next = readPtr(nb, 0, width)
    if (next && next !== self && !looksLikePtr(next, width)) {
      error = `bad next @ ${cur.toString(16)}`
      break
    }
    cur = next >>> 0
  }

  return { header, nodes, truncated, error }
}
