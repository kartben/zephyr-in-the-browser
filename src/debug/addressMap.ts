/**
 * "What lives at this address?" for a stopped guest.
 *
 * Everything needed is already parsed by the time the Mem pane can show
 * anything: object core knows every live kernel object and its type, and the
 * ELF knows thread stacks, data symbols and functions. This joins them into one
 * sorted range table so a word read out of guest memory can be named.
 *
 * Host-only and read-only — resolving costs no RSP traffic.
 */

import type { ObjectCoreField, ObjectCoreSnapshot } from '@/debug/kernel/objectCores'
import type { StackRegion } from '@/debug/elfStacks'
import { resolveSymbol, type SymbolIndex } from '@/debug/elfSymbols'

/**
 * Ordered best-first: a k_thread is also a data symbol and sits inside a stack
 * region, and the object-core answer is the one worth showing.
 */
export type AddressKind = 'object' | 'objectCore' | 'stack' | 'data' | 'code'

export interface ResolvedAddress {
  kind: AddressKind
  /** Symbol / object name, without the offset. */
  name: string
  /** Start of the containing thing. */
  base: number
  /** Bytes past {@link base}; 0 for an exact hit. */
  offset: number
  /** Byte span, when known. */
  size: number | null
  /** Object-core type code (`SEM4`, `THRD`, …) for kernel objects. */
  typeCode?: string
  /** Plural type label from object core, e.g. "Semaphores". */
  typeName?: string
  /** Live fields object core already decoded — the hover card shows them. */
  fields?: readonly ObjectCoreField[]
}

interface Range {
  start: number
  end: number
  kind: AddressKind
  name: string
  size: number | null
  typeCode?: string
  typeName?: string
  fields?: readonly ObjectCoreField[]
}

export interface AddressMap {
  /** Best match for `addr`, or null when nothing owns it. */
  resolve: (addr: number) => ResolvedAddress | null
  /** True when there is nothing to resolve against (no ELF, no objects). */
  empty: boolean
}

export interface AddressMapSources {
  objects: ObjectCoreSnapshot | null
  stacks: readonly StackRegion[]
  symbols: SymbolIndex | null
}

const KIND_RANK: Record<AddressKind, number> = {
  object: 0,
  objectCore: 1,
  stack: 2,
  data: 3,
  code: 4,
}

/** `foo`, or `foo+0x18` when the hit is inside rather than at the start. */
export function formatTarget(target: ResolvedAddress): string {
  return target.offset === 0 ? target.name : `${target.name}+0x${target.offset.toString(16)}`
}

/**
 * Ranked so the *tightest, most specific* owner wins: an exact hit beats an
 * interior one, then the kind order above, then the smaller span — which is
 * what puts a k_sem ahead of the array it lives in.
 */
function better(a: Range, b: Range, addr: number): Range {
  const aExact = a.start === addr ? 0 : 1
  const bExact = b.start === addr ? 0 : 1
  if (aExact !== bExact) return aExact < bExact ? a : b
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
    return KIND_RANK[a.kind] < KIND_RANK[b.kind] ? a : b
  }
  return a.end - a.start <= b.end - b.start ? a : b
}

function push(out: Range[], range: Range) {
  if (!Number.isFinite(range.start) || range.end <= range.start) return
  out.push(range)
}

/**
 * Build the range table. Cheap enough to redo whenever object core is re-read
 * (a few hundred entries), so callers can memo on the snapshot identity.
 */
export function buildAddressMap({ objects, stacks, symbols }: AddressMapSources): AddressMap {
  const ranges: Range[] = []

  for (const type of objects?.types ?? []) {
    for (const object of type.objects) {
      const size = object.size ?? type.objectSize
      push(ranges, {
        start: object.addr,
        end: object.addr + Math.max(1, size ?? 1),
        kind: 'object',
        name: object.name,
        size: size ?? null,
        typeCode: object.typeCode,
        typeName: object.typeName,
        fields: object.fields,
      })
      // The _obj_core member itself: walking the type's linked list lands here,
      // and naming it is what makes that chain readable. The `.obj_core` suffix
      // is not decoration — following the link lands on the member, not on the
      // object, and a chip reading plain `fork_objs[1]` would promise otherwise.
      if (object.coreAddr !== object.addr) {
        push(ranges, {
          start: object.coreAddr,
          end: object.coreAddr + 1,
          kind: 'objectCore',
          name: `${object.name}.obj_core`,
          size: null,
          typeCode: object.typeCode,
          typeName: object.typeName,
        })
      }
    }
  }

  for (const stack of stacks) {
    push(ranges, {
      start: stack.addr,
      end: stack.addr + stack.size,
      kind: 'stack',
      name: stack.name,
      size: stack.size,
    })
  }

  for (const symbol of symbols?.objects.values() ?? []) {
    push(ranges, {
      start: symbol.addr,
      end: symbol.addr + Math.max(1, symbol.size),
      kind: 'data',
      name: symbol.name,
      size: symbol.size || null,
    })
  }

  ranges.sort((a, b) => a.start - b.start)
  const starts = ranges.map((r) => r.start)

  const resolve = (addr: number): ResolvedAddress | null => {
    if (!Number.isFinite(addr)) return null

    let best: Range | null = null
    // Ranges nest and overlap, so walk left from the insertion point while a
    // candidate can still reach `addr`. Bounded in practice: the widest entry
    // is a stack or a symbol array, not the whole image.
    let lo = 0
    let hi = starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! <= addr) lo = mid + 1
      else hi = mid
    }
    for (let i = lo - 1; i >= 0; i--) {
      const range = ranges[i]!
      if (range.end > addr) best = best ? better(best, range, addr) : range
      // An exact hit on the tightest kind cannot be beaten; stop early.
      if (best && best.start === addr && best.kind === 'object') break
    }

    if (best) {
      return {
        kind: best.kind,
        name: best.name,
        base: best.start,
        offset: addr - best.start,
        size: best.size,
        ...(best.typeCode ? { typeCode: best.typeCode } : {}),
        ...(best.typeName ? { typeName: best.typeName } : {}),
        ...(best.fields && best.fields.length > 0 ? { fields: best.fields } : {}),
      }
    }

    // Functions come last: a code pointer in a struct is nearly always a
    // callback, and the symtab already knows how to name one.
    const fn = resolveSymbol(symbols, addr)
    if (fn) {
      return { kind: 'code', name: fn.name, base: fn.addr, offset: fn.offset, size: null }
    }
    return null
  }

  return { resolve, empty: ranges.length === 0 && !symbols }
}
