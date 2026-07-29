/**
 * Soft shape scores for View-as menu hints. Never auto-apply — see plan.
 */

import {
  type MemoryReader,
  type PtrWidth,
  looksLikePtr,
  readBytes,
  readPtr,
  readU16,
  readU32,
} from '@/debug/ds/mem'
import { parseRbTreeHeader, rbtreeHeaderSize } from '@/debug/ds/rbtree'
import { parseDListHeader, dlistHeaderSize } from '@/debug/ds/dlist'
import { parseSListHeader, slistHeaderSize } from '@/debug/ds/slist'
import { ringUsed } from '@/debug/ds/ringBuf'

export type DsKind = 'rbtree' | 'ring_buf' | 'sys_slist' | 'sys_dlist'

export interface DsGuess {
  kind: DsKind
  /** 0…1 rough confidence. */
  score: number
  reason: string
}

export async function guessDsKinds(
  read: MemoryReader,
  addr: number,
  width: PtrWidth,
): Promise<DsGuess[]> {
  const bytes = await readBytes(read, addr, Math.max(rbtreeHeaderSize(width), width * 2 + 24))
  if (!bytes) return []

  const out: DsGuess[] = []

  // dlist empty is the strongest cheap signal.
  if (bytes.length >= dlistHeaderSize(width)) {
    const d = parseDListHeader(bytes, addr, width)
    if (d.empty) {
      out.push({ kind: 'sys_dlist', score: 0.85, reason: 'head/tail point at self' })
    } else if (looksLikePtr(d.head, width) && looksLikePtr(d.tail, width)) {
      out.push({ kind: 'sys_dlist', score: 0.35, reason: 'two aligned pointers' })
    }
  }

  if (bytes.length >= slistHeaderSize(width)) {
    const s = parseSListHeader(bytes, addr, width)
    if (s.head === 0 && s.tail === 0) {
      out.push({ kind: 'sys_slist', score: 0.4, reason: 'empty head/tail' })
    } else if (looksLikePtr(s.head, width) && looksLikePtr(s.tail, width)) {
      out.push({ kind: 'sys_slist', score: 0.3, reason: 'two aligned pointers' })
    }
  }

  if (bytes.length >= rbtreeHeaderSize(width)) {
    const r = parseRbTreeHeader(bytes, addr, width)
    let score = 0
    const reasons: string[] = []
    if (r.root === 0 || looksLikePtr(r.root, width)) {
      score += 0.2
      reasons.push(r.root === 0 ? 'null root' : 'aligned root')
    }
    if (looksLikePtr(r.lessthanFn, width) && r.lessthanFn !== 0) {
      score += 0.25
      reasons.push('lessthan_fn')
    }
    if (r.maxDepth >= 0 && r.maxDepth <= 64) {
      score += 0.15
      reasons.push('max_depth')
    }
    if (score >= 0.35) {
      out.push({ kind: 'rbtree', score: Math.min(0.75, score), reason: reasons.join(', ') })
    }
  }

  // ring_buf uint16 layout sniff
  if (bytes.length >= width + 6 * 2 + 4) {
    const buffer = readPtr(bytes, 0, width)
    const o = width
    const putTail = readU16(bytes, o + 2)
    const getHead = readU16(bytes, o + 6)
    const sizeOff = (width + 12 + 3) & ~3
    const size = readU32(bytes, sizeOff)
    if (size >= 2 && size <= 1 << 20 && (buffer === 0 || looksLikePtr(buffer, width))) {
      const used = ringUsed(size, getHead, putTail)
      if (used <= size && putTail < size * 2 && getHead < size * 2) {
        out.push({
          kind: 'ring_buf',
          score: 0.55,
          reason: `size=${size} used≈${used}`,
        })
      }
    }
  }

  out.sort((a, b) => b.score - a.score)
  // Dedupe by kind, keep best
  const best = new Map<DsKind, DsGuess>()
  for (const g of out) {
    const prev = best.get(g.kind)
    if (!prev || g.score > prev.score) best.set(g.kind, g)
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}
