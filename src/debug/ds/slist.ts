/**
 * Zephyr sys_slist decode (include/zephyr/sys/slist.h).
 * List: { head, tail }. Node: { next }.
 */

import {
  MAX_WALK_NODES,
  type MemoryReader,
  type PtrWidth,
  looksLikePtr,
  readBytes,
  readPtr,
} from '@/debug/ds/mem'

export interface SListHeader {
  addr: number
  head: number
  tail: number
}

export interface SListWalk {
  header: SListHeader
  /** Node addresses in list order (head → … → tail). */
  nodes: number[]
  truncated: boolean
  error: string | null
}

export function slistHeaderSize(width: PtrWidth): number {
  return width * 2
}

export function parseSListHeader(bytes: Uint8Array, addr: number, width: PtrWidth): SListHeader {
  return {
    addr: addr >>> 0,
    head: readPtr(bytes, 0, width),
    tail: readPtr(bytes, width, width),
  }
}

export async function loadSList(
  read: MemoryReader,
  addr: number,
  width: PtrWidth,
  maxNodes = MAX_WALK_NODES,
): Promise<SListWalk> {
  const hb = await readBytes(read, addr, slistHeaderSize(width))
  if (!hb || hb.length < slistHeaderSize(width)) {
    return {
      header: { addr: addr >>> 0, head: 0, tail: 0 },
      nodes: [],
      truncated: false,
      error: 'could not read sys_slist',
    }
  }
  const header = parseSListHeader(hb, addr, width)
  if (!header.head) {
    return { header, nodes: [], truncated: false, error: null }
  }
  if (!looksLikePtr(header.head, width)) {
    return { header, nodes: [], truncated: false, error: 'head does not look like a pointer' }
  }

  const nodes: number[] = []
  const seen = new Set<number>()
  let cur = header.head >>> 0
  let truncated = false
  let error: string | null = null

  while (cur) {
    if (seen.has(cur)) {
      error = 'cycle detected'
      break
    }
    seen.add(cur)
    if (nodes.length >= maxNodes) {
      truncated = true
      break
    }
    nodes.push(cur)
    const nb = await readBytes(read, cur, width)
    if (!nb || nb.length < width) {
      error = `failed to read snode @ ${cur.toString(16)}`
      break
    }
    const next = readPtr(nb, 0, width)
    if (next && !looksLikePtr(next, width)) {
      error = `bad next @ ${cur.toString(16)}`
      break
    }
    cur = next >>> 0
  }

  if (!error && !truncated && header.tail && nodes.length && nodes[nodes.length - 1] !== header.tail) {
    error = 'walk did not end at tail'
  }

  return { header, nodes, truncated, error }
}
