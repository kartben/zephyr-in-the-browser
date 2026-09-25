/**
 * Zephyr rbtree / rbnode decode (include/zephyr/sys/rb.h + lib/utils/rb.c).
 *
 * Color bit lives in children[0] LSB: BLACK=1, RED=0. Mask before chase.
 */

import {
  MAX_WALK_NODES,
  type MemoryReader,
  type PtrWidth,
  looksLikePtr,
  readBytes,
  readPtr,
  readU32,
} from '@/debug/ds/mem'

export type RbColor = 'red' | 'black'

export interface RbTreeHeader {
  addr: number
  root: number
  lessthanFn: number
  maxDepth: number
}

export interface RbNode {
  addr: number
  color: RbColor
  left: number
  right: number
}

export interface RbTreeWalk {
  header: RbTreeHeader
  nodes: Map<number, RbNode>
  /** Addresses in discovery order (BFS). */
  order: number[]
  truncated: boolean
  error: string | null
}

/** Hardcoded AArch64 / AArch32 layout — fields are pointer-sized then an int. */
export function rbtreeHeaderSize(width: PtrWidth): number {
  // root, lessthan_fn, max_depth (+ pad on aarch64 to 8-align if needed — int is fine at +2*width)
  return width * 2 + 4
}

export function parseRbTreeHeader(bytes: Uint8Array, addr: number, width: PtrWidth): RbTreeHeader {
  const root = readPtr(bytes, 0, width)
  const lessthanFn = readPtr(bytes, width, width)
  const maxDepth = readU32(bytes, width * 2)
  return { addr: addr >>> 0, root, lessthanFn, maxDepth }
}

export function parseRbNode(bytes: Uint8Array, addr: number, width: PtrWidth): RbNode {
  const rawLeft = readPtr(bytes, 0, width)
  const right = readPtr(bytes, width, width)
  const color: RbColor = rawLeft & 1 ? 'black' : 'red'
  const left = (rawLeft & ~1) >>> 0
  return { addr: addr >>> 0, color, left, right }
}

export async function loadRbTree(
  read: MemoryReader,
  addr: number,
  width: PtrWidth,
  maxNodes = MAX_WALK_NODES,
): Promise<RbTreeWalk> {
  const hdrBytes = await readBytes(read, addr, rbtreeHeaderSize(width))
  if (!hdrBytes || hdrBytes.length < rbtreeHeaderSize(width)) {
    return {
      header: { addr: addr >>> 0, root: 0, lessthanFn: 0, maxDepth: 0 },
      nodes: new Map(),
      order: [],
      truncated: false,
      error: 'could not read rbtree header',
    }
  }
  const header = parseRbTreeHeader(hdrBytes, addr, width)
  const nodes = new Map<number, RbNode>()
  const order: number[] = []
  let truncated = false
  let error: string | null = null

  if (!header.root) {
    return { header, nodes, order, truncated, error: null }
  }
  if (!looksLikePtr(header.root, width)) {
    return { header, nodes, order, truncated, error: 'root does not look like a pointer' }
  }

  const queue = [header.root >>> 0]
  const seen = new Set<number>()
  while (queue.length) {
    const naddr = queue.shift()!
    if (seen.has(naddr)) continue
    seen.add(naddr)
    if (order.length >= maxNodes) {
      truncated = true
      break
    }
    const nb = await readBytes(read, naddr, width * 2)
    if (!nb || nb.length < width * 2) {
      error = `failed to read rbnode @ ${naddr.toString(16)}`
      break
    }
    const node = parseRbNode(nb, naddr, width)
    nodes.set(naddr, node)
    order.push(naddr)
    for (const child of [node.left, node.right]) {
      if (child && looksLikePtr(child, width) && !seen.has(child)) queue.push(child)
    }
  }

  return { header, nodes, order, truncated, error }
}
