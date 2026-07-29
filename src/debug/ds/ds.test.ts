import { describe, expect, it } from 'vitest'
import { parseRbNode, parseRbTreeHeader } from '@/debug/ds/rbtree'
import { ringUsed } from '@/debug/ds/ringBuf'
import { parseSListHeader } from '@/debug/ds/slist'
import { parseDListHeader } from '@/debug/ds/dlist'
import { looksLikePtr, readPtr } from '@/debug/ds/mem'
import { loadRbTree, loadSList, loadDList, loadRingBuf } from '@/debug/ds'
import type { MemoryReader } from '@/debug/ds/mem'

function le(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes)
}

function u32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

function memMap(map: Record<number, Uint8Array>): MemoryReader {
  return async (addr, length) => {
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i++) {
      const a = (addr + i) >>> 0
      const page = Object.keys(map)
        .map(Number)
        .sort((x, y) => y - x)
        .find((base) => a >= base && a < base + map[base]!.length)
      if (page === undefined) return null
      out[i] = map[page]![a - page]!
    }
    return out
  }
}

describe('ds mem helpers', () => {
  it('reads little-endian pointers', () => {
    const b = le([...u32(0x40001000), ...u32(0)])
    expect(readPtr(b, 0, 4)).toBe(0x40001000)
    expect(looksLikePtr(0x40001000, 4)).toBe(true)
    expect(looksLikePtr(0x40001001, 4)).toBe(false)
  })
})

describe('rbtree', () => {
  it('parses color from children[0] LSB', () => {
    // left = 0x40002001 → black, real ptr 0x40002000
    const b = le([...u32(0x40002001), ...u32(0x40003000)])
    const n = parseRbNode(b, 0x40001000, 4)
    expect(n.color).toBe('black')
    expect(n.left).toBe(0x40002000)
    expect(n.right).toBe(0x40003000)
  })

  it('walks a tiny tree', async () => {
    const root = 0x40001000
    const left = 0x40002000
    const right = 0x40003000
    const tree = 0x40000000
    const read = memMap({
      [tree]: le([...u32(root), ...u32(0x1000), ...u32(2)]),
      [root]: le([...u32(left | 1), ...u32(right)]), // black root
      [left]: le([...u32(0), ...u32(0)]), // red leaf (LSB 0)
      [right]: le([...u32(0), ...u32(0)]),
    })
    const walk = await loadRbTree(read, tree, 4)
    expect(walk.error).toBeNull()
    expect(walk.order).toEqual([root, left, right])
    expect(walk.nodes.get(root)!.color).toBe('black')
    expect(walk.nodes.get(left)!.color).toBe('red')
    expect(parseRbTreeHeader(le([...u32(root), ...u32(0x1000), ...u32(2)]), tree, 4).maxDepth).toBe(2)
  })
})

describe('ring_buf', () => {
  it('computes used modulo 2*size (put.tail − get.head)', () => {
    expect(ringUsed(256, 132, 196)).toBe(64)
    // wrap in the 2*size space: get=400, put=100 → 212 used
    expect(ringUsed(256, 400, 100)).toBe(212)
  })

  it('loads a uint16 ring header', async () => {
    // put head,tail,base = 196,196,0 ; get = 132,132,0 ; size 256
    // (no claim in flight — head == tail on each side)
    const addr = 0x40031000
    const buf = 0x40031100
    const bytes = le([
      ...u32(buf),
      196, 0, 196, 0, 0, 0, // put
      132, 0, 132, 0, 0, 0, // get
      ...u32(256),
    ])
    // Pad so a wide read for uint32 layout still succeeds (zeros).
    const padded = new Uint8Array(48)
    padded.set(bytes)
    const read = memMap({ [addr]: padded })
    const { ring, error } = await loadRingBuf(read, addr, 4)
    expect(error).toBeNull()
    expect(ring?.size).toBe(256)
    expect(ring?.used).toBe(64)
    expect(ring?.buffer).toBe(buf)
  })
})
describe('slist / dlist', () => {
  it('walks an slist', async () => {
    const list = 0x1000
    const a = 0x2000
    const b = 0x3000
    const read = memMap({
      [list]: le([...u32(a), ...u32(b)]),
      [a]: le([...u32(b)]),
      [b]: le([...u32(0)]),
    })
    const walk = await loadSList(read, list, 4)
    expect(walk.nodes).toEqual([a, b])
    expect(parseSListHeader(le([...u32(a), ...u32(b)]), list, 4).tail).toBe(b)
  })

  it('detects empty dlist via self pointers', async () => {
    const list = 0x1000
    const read = memMap({
      [list]: le([...u32(list), ...u32(list)]),
    })
    const walk = await loadDList(read, list, 4)
    expect(walk.header.empty).toBe(true)
    expect(walk.nodes).toEqual([])
    expect(parseDListHeader(le([...u32(list), ...u32(list)]), list, 4).empty).toBe(true)
  })

  it('walks a one-node dlist ring', async () => {
    const list = 0x1000
    const n = 0x2000
    // list.head=n, list.tail=n; n.next=list, n.prev=list
    const read = memMap({
      [list]: le([...u32(n), ...u32(n)]),
      [n]: le([...u32(list), ...u32(list)]),
    })
    const walk = await loadDList(read, list, 4)
    expect(walk.header.empty).toBe(false)
    expect(walk.nodes).toEqual([n])
  })
})
