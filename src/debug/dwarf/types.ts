/**
 * C types, read from DWARF on demand.
 *
 * A type is a chain of DIEs (`const struct device *` is a pointer to a const
 * to a struct), and chains loop (`struct list_node` points to itself). So a
 * reference stays a DIE offset until something asks for it, and each offset is
 * read once. A type the evaluator makes up (the pointer `&x` yields) is a
 * {@link CType} in place of the offset.
 */

import { AT, ATE, TAG } from '@/debug/dwarf/constants'
import type { Die, DwarfInfo } from '@/debug/dwarf/info'

/** A DIE offset, a type made on the spot, or null for `void`. */
export type TypeRef = number | CType | null

export interface Member {
  name: string | null
  /** Byte offset from the start of the struct. */
  offset: number
  type: TypeRef
  /** Bitfields: width, and offset in bits from the start of the struct. */
  bitSize?: number
  bitOffset?: number
}

export interface Enumerator {
  name: string
  value: bigint
}

export type CType =
  | { kind: 'void' }
  | { kind: 'base'; name: string; size: number; encoding: number }
  | { kind: 'pointer'; size: number; target: TypeRef }
  | {
      kind: 'struct'
      keyword: 'struct' | 'union'
      name: string | null
      size: number | null
      members: Member[]
      /** Only declared here (`struct k_thread;`): members live elsewhere. */
      declaration: boolean
    }
  | { kind: 'array'; elem: TypeRef; counts: Array<number | null> }
  | { kind: 'enum'; name: string | null; size: number; enumerators: Enumerator[]; signed: boolean }
  | { kind: 'typedef'; name: string; target: TypeRef }
  | { kind: 'qualified'; qualifier: string; target: TypeRef }
  | { kind: 'function'; returns: TypeRef; params: TypeRef[]; variadic: boolean }

const VOID: CType = { kind: 'void' }

const QUALIFIERS = new Map<number, string>([
  [TAG.const_type, 'const'],
  [TAG.volatile_type, 'volatile'],
  [TAG.restrict_type, 'restrict'],
  [TAG.atomic_type, '_Atomic'],
])

export class TypeTable {
  private readonly cache = new Map<number, CType>()

  constructor(
    private readonly info: DwarfInfo,
    readonly pointerSize: number,
  ) {}

  /** The type a reference names. */
  get(ref: TypeRef): CType {
    if (ref === null) return VOID
    if (typeof ref !== 'number') return ref
    const cached = this.cache.get(ref)
    if (cached) return cached
    const die = this.info.die(ref)
    const type = die ? this.read(die) : VOID
    this.cache.set(ref, type)
    return type
  }

  /** A DIE's `DW_AT_type`, as a reference. */
  typeOf(die: Die): TypeRef {
    const value = this.info.attr(die, AT.type)
    return value?.form === 'ref' ? value.offset : null
  }

  /** Through typedefs and qualifiers to the type that says how to read bytes. */
  strip(ref: TypeRef): CType {
    let type = this.get(ref)
    for (let hops = 0; hops < 32; hops++) {
      if (type.kind === 'typedef' || type.kind === 'qualified') type = this.get(type.target)
      else break
    }
    return type
  }

  /**
   * A struct with its members: a declaration-only struct (an opaque handle in
   * this unit) is looked up by name in the units that define it.
   */
  complete(type: CType): CType {
    if (type.kind !== 'struct' || !type.declaration || !type.name) return type
    const tag = type.keyword === 'union' ? TAG.union_type : TAG.structure_type
    for (const entry of this.info.lookupName(type.name)) {
      if (entry.tag !== tag || !entry.defined) continue
      const full = this.get(entry.offset)
      if (full.kind === 'struct' && !full.declaration) return full
    }
    return type
  }

  sizeOf(ref: TypeRef): number | null {
    const type = this.complete(this.strip(ref))
    switch (type.kind) {
      case 'base':
      case 'pointer':
      case 'enum':
        return type.size
      case 'struct':
        return type.size
      case 'array': {
        const elem = this.sizeOf(type.elem)
        if (elem === null) return null
        let total = elem
        for (const count of type.counts) {
          if (count === null) return null
          total *= count
        }
        return total
      }
      case 'function':
        return 1
      default:
        return null
    }
  }

  /** The member called `name`, looking inside anonymous structs and unions. */
  member(ref: TypeRef, name: string): Member | null {
    const type = this.complete(this.strip(ref))
    if (type.kind !== 'struct') return null
    for (const m of type.members) if (m.name === name) return m
    for (const m of type.members) {
      if (m.name !== null) continue
      const inner = this.member(m.type, name)
      if (inner) {
        return {
          ...inner,
          offset: m.offset + inner.offset,
          ...(inner.bitOffset !== undefined ? { bitOffset: m.offset * 8 + inner.bitOffset } : {}),
        }
      }
    }
    return null
  }

  /** The type as C spells it: `const struct device *`, `char [16]`. */
  name(ref: TypeRef): string {
    return this.declarator(ref, '', 0)
  }

  private declarator(ref: TypeRef, inner: string, depth: number): string {
    if (depth > 16) return '…'
    const type = this.get(ref)
    const join = (base: string) => (inner ? `${base} ${inner}` : base)
    switch (type.kind) {
      case 'void':
        return join('void')
      case 'base':
        return join(type.name)
      case 'typedef':
        return join(type.name)
      case 'struct':
        return join(type.name ? `${type.keyword} ${type.name}` : `${type.keyword} {…}`)
      case 'enum':
        return join(type.name ? `enum ${type.name}` : 'enum {…}')
      case 'pointer': {
        const target = this.get(type.target)
        const wrapped = target.kind === 'array' || target.kind === 'function'
        return this.declarator(type.target, wrapped ? `(*${inner})` : `*${inner}`, depth + 1)
      }
      case 'qualified': {
        const target = this.get(type.target)
        if (target.kind === 'pointer') {
          return this.declarator(type.target, inner ? `${type.qualifier} ${inner}` : type.qualifier, depth + 1)
        }
        return `${type.qualifier} ${this.declarator(type.target, inner, depth + 1)}`
      }
      case 'array': {
        const dims = type.counts.map((c) => `[${c ?? ''}]`).join('')
        return this.declarator(type.elem, `${inner}${dims}`, depth + 1)
      }
      case 'function': {
        const params = type.params.map((p) => this.name(p))
        if (type.variadic) params.push('...')
        const list = params.length > 0 ? params.join(', ') : 'void'
        return this.declarator(type.returns, `${inner}(${list})`, depth + 1)
      }
    }
  }

  private read(die: Die): CType {
    const info = this.info
    const target = (): TypeRef => this.typeOf(die)
    const size = info.constant(die, AT.byte_size)
    switch (die.tag) {
      case TAG.base_type:
        return {
          kind: 'base',
          name: info.name(die) ?? '?',
          size: size ?? 0,
          encoding: info.constant(die, AT.encoding) ?? ATE.signed,
        }
      case TAG.pointer_type:
        return { kind: 'pointer', size: size ?? this.pointerSize, target: target() }
      case TAG.typedef:
        return { kind: 'typedef', name: info.name(die) ?? '?', target: target() }
      case TAG.structure_type:
      case TAG.union_type:
        return {
          kind: 'struct',
          keyword: die.tag === TAG.union_type ? 'union' : 'struct',
          name: info.name(die),
          size,
          members: die.children.filter((c) => c.tag === TAG.member).map((c) => this.readMember(c)),
          declaration: die.attrs.get(AT.declaration)?.form === 'flag',
        }
      case TAG.array_type:
        return {
          kind: 'array',
          elem: target(),
          counts: die.children
            .filter((c) => c.tag === TAG.subrange_type)
            .map((c) => subrangeCount(c)),
        }
      case TAG.enumeration_type: {
        const enumerators: Enumerator[] = []
        let negative = false
        for (const c of die.children) {
          if (c.tag !== TAG.enumerator) continue
          const value = c.attrs.get(AT.const_value)
          const big = value?.form === 'const' ? value.big : 0n
          if (big < 0n) negative = true
          enumerators.push({ name: info.name(c) ?? '?', value: big })
        }
        const underlying = this.strip(target())
        const signed =
          negative ||
          (underlying.kind === 'base' &&
            (underlying.encoding === ATE.signed || underlying.encoding === ATE.signed_char))
        return { kind: 'enum', name: info.name(die), size: size ?? 4, enumerators, signed }
      }
      case TAG.subroutine_type:
        return {
          kind: 'function',
          returns: target(),
          params: die.children
            .filter((c) => c.tag === TAG.formal_parameter)
            .map((c) => this.typeOf(c)),
          variadic: die.children.some((c) => c.tag === TAG.unspecified_parameters),
        }
      default: {
        const qualifier = QUALIFIERS.get(die.tag)
        if (qualifier) return { kind: 'qualified', qualifier, target: target() }
        return VOID
      }
    }
  }

  private readMember(die: Die): Member {
    const info = this.info
    const loc = die.attrs.get(AT.data_member_location)
    let offset = 0
    if (loc?.form === 'const') offset = loc.value
    else if (loc?.form === 'block' && loc.bytes[0] === 0x23) offset = uleb(loc.bytes, 1)
    const member: Member = { name: info.name(die), offset, type: this.typeOf(die) }
    const bitSize = info.constant(die, AT.bit_size)
    if (bitSize !== null) {
      const dataBitOffset = info.constant(die, AT.data_bit_offset)
      if (dataBitOffset !== null) {
        member.bitOffset = dataBitOffset
      } else {
        // DWARF 2/3: counted from the most significant bit of a storage unit
        // of `byte_size` at `data_member_location`. Little-endian targets only.
        const storage = info.constant(die, AT.byte_size) ?? this.sizeOf(member.type) ?? 0
        const fromMsb = info.constant(die, AT.bit_offset) ?? 0
        member.bitOffset = offset * 8 + storage * 8 - fromMsb - bitSize
      }
      member.bitSize = bitSize
      member.offset = Math.floor(member.bitOffset / 8)
    }
    return member
  }
}

function subrangeCount(die: Die): number | null {
  const count = die.attrs.get(AT.count)
  if (count?.form === 'const') return count.value
  const upper = die.attrs.get(AT.upper_bound)
  if (upper?.form !== 'const') return null
  const value = upper.big
  // A zero-length array's bound is written as -1, sometimes as all ones.
  const top = upper.size > 0 ? BigInt.asIntN(upper.size * 8, value) : value
  return top < 0n ? 0 : Number(top) + 1
}

function uleb(bytes: Uint8Array, at: number): number {
  let value = 0
  let scale = 1
  for (let i = at; i < bytes.length; i++) {
    const byte = bytes[i]!
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) break
    scale *= 128
  }
  return value
}
