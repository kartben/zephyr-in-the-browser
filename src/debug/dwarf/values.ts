/**
 * Turn a typed location into what a reader sees, the way GDB prints it in VS
 * Code: `11`, `0x20001a3c <rx_buf>`, `{...}` with members to expand.
 *
 * Reads are lazy. A value's one-line text costs one read of its own bytes; a
 * struct's members, a pointer's target and an array's elements are read when
 * someone expands them. On the QEMU path every read is a gdbstub round trip,
 * so the caller is expected to hand in a target that caches by stop.
 */

import { ATE } from '@/debug/dwarf/constants'
import type { DwarfEngine } from '@/debug/dwarf/engine'
import { OPTIMIZED_OUT, type Location } from '@/debug/dwarf/locexpr'
import type { CType, Member, TypeRef } from '@/debug/dwarf/types'

/** A typed place: what an expression or a variable evaluates to. */
export interface Val {
  /** How the reader would write it: `evt`, `evt->code`, `[3]`. */
  name: string
  type: TypeRef
  loc: Location
  /**
   * Where the value starts inside a location that has no address: a member of
   * a struct held in registers is a slice of the registers' bytes.
   */
  byteOffset?: number
  /** A bitfield: offset and width in bits from the value's first byte. */
  bits?: { offset: number; size: number }
}

export interface ValueTarget {
  read(addr: number, size: number): Promise<Uint8Array | null>
  reg(n: number): bigint | null
  /** `name+off` for a data or code address, when the symbols say. */
  label(addr: number): string | null
  /** Drop a code address's mode bits (the Thumb bit) before naming it. */
  codeAddress(addr: number): number
}

export interface ValueView {
  name: string
  typeName: string
  /** The value on one line, or the reason there is none. */
  text: string
  /** Set when there is no value to show: `<optimized out>`, a failed read. */
  unavailable: boolean
  expandable: boolean
  children(): Promise<ValueView[]>
}

const CANNOT_READ = '<cannot read memory>'

/** Elements and members shown before "… N more". */
const MAX_CHILDREN = 64
const MAX_STRING = 64

export class ValueReader {
  constructor(
    private readonly engine: DwarfEngine,
    private readonly target: ValueTarget,
  ) {}

  private get types() {
    return this.engine.types
  }

  /** The view of a value; never throws. */
  async view(val: Val): Promise<ValueView> {
    const base = { name: val.name, typeName: this.types.name(val.type) }
    if (val.loc.kind === 'unavailable') {
      return { ...base, text: describeUnavailable(val.loc.reason), unavailable: true, expandable: false, children: none }
    }
    const type = this.types.complete(this.types.strip(val.type))
    try {
      const text = await this.text(val, type)
      if (text === null) {
        return { ...base, text: CANNOT_READ, unavailable: true, expandable: false, children: none }
      }
      const expandable = this.expandable(type, val)
      return {
        ...base,
        text,
        unavailable: false,
        expandable,
        children: expandable ? () => this.children(val, type) : none,
      }
    } catch {
      return { ...base, text: CANNOT_READ, unavailable: true, expandable: false, children: none }
    }
  }

  /** `size` bytes of a value, from its first byte. */
  async bytes(val: Pick<Val, 'loc' | 'byteOffset'>, size: number): Promise<Uint8Array | null> {
    const skip = val.byteOffset ?? 0
    if (skip === 0) return this.locBytes(val.loc, size)
    const all = await this.locBytes(val.loc, skip + size)
    return all ? all.subarray(skip, skip + size) : null
  }

  private async locBytes(loc: Location, size: number): Promise<Uint8Array | null> {
    switch (loc.kind) {
      case 'memory':
        return this.target.read(Number(loc.addr), size)
      case 'register': {
        // A value wider than a register spans the next ones (r0:r1).
        const out = new Uint8Array(size)
        const regBytes = this.engine.addrSize
        for (let i = 0; i * regBytes < size; i++) {
          const v = this.target.reg(loc.reg + i)
          if (v === null) return null
          out.set(toBytes(v, Math.min(regBytes, size - i * regBytes)), i * regBytes)
        }
        return out
      }
      case 'value':
        return toBytes(loc.value, size)
      case 'implicit': {
        const out = new Uint8Array(size)
        out.set(loc.bytes.subarray(0, size))
        return out
      }
      case 'pieces': {
        const out = new Uint8Array(size)
        let at = 0
        for (const piece of loc.pieces) {
          if (at >= size) break
          if (!piece.loc) return null
          const part = await this.locBytes(piece.loc, piece.bytes)
          if (!part) return null
          out.set(part.subarray(0, Math.min(piece.bytes, size - at)), at)
          at += piece.bytes
        }
        return at >= size ? out : null
      }
      case 'unavailable':
        return null
    }
  }

  /** A scalar's value as a bigint (integers, pointers, enums, bools). */
  async scalar(val: Val): Promise<bigint | null> {
    const type = this.types.strip(val.type)
    const size = this.types.sizeOf(val.type)
    if (size === null || size > 8 || size === 0) return null
    const bytes = await this.bytes(val, val.bits ? Math.ceil((val.bits.offset + val.bits.size) / 8) : size)
    if (!bytes) return null
    let v = fromBytes(bytes)
    if (val.bits) v = (v >> BigInt(val.bits.offset)) & ((1n << BigInt(val.bits.size)) - 1n)
    if (isSigned(type)) v = BigInt.asIntN(val.bits ? val.bits.size : size * 8, v)
    return v
  }

  /** A member of a struct value, in place. */
  member(parent: Val, m: Member, name = `${parent.name}.${m.name ?? '<anonymous>'}`): Val {
    const child = at(parent, m.offset, m.type, name)
    if (m.bitSize !== undefined && m.bitOffset !== undefined) {
      child.bits = { offset: m.bitOffset - m.offset * 8, size: m.bitSize }
    }
    return child
  }

  /** Element `i` of an array value. */
  element(parent: Val, elem: TypeRef, i: number, name = `${parent.name}[${i}]`): Val {
    return at(parent, i * (this.types.sizeOf(elem) ?? 0), elem, name)
  }

  /** What a pointer value points at, or null for NULL and `void *`. */
  async deref(val: Val, name = `*${val.name}`): Promise<Val | null> {
    const type = this.types.strip(val.type)
    if (type.kind !== 'pointer') return null
    const addr = await this.scalar(val)
    if (addr === null || addr === 0n) return null
    return { name, type: type.target, loc: { kind: 'memory', addr } }
  }

  private expandable(type: CType, val: Val): boolean {
    if (val.bits) return false
    if (type.kind === 'struct') return type.members.length > 0
    if (type.kind === 'array') return !this.isCharArray(type) && (type.counts[0] ?? 0) > 0
    if (type.kind === 'pointer') {
      const target = this.types.complete(this.types.strip(type.target))
      return target.kind !== 'void' && target.kind !== 'function'
    }
    return false
  }

  private async children(val: Val, type: CType): Promise<ValueView[]> {
    if (type.kind === 'struct') return this.memberViews(val, type)
    if (type.kind === 'array') return this.elementViews(val, type)
    if (type.kind === 'pointer') {
      const target = await this.deref(val)
      if (!target) return []
      const pointee = this.types.complete(this.types.strip(target.type))
      // A pointer to a struct opens onto the struct's members, as VS Code does:
      // `evt` expands to `dev`, `sync`, … rather than to a lone `*evt`.
      if (pointee.kind === 'struct') return this.memberViews(target, pointee)
      return [await this.view(target)]
    }
    return []
  }

  private async memberViews(val: Val, type: CType & { kind: 'struct' }): Promise<ValueView[]> {
    const views: ValueView[] = []
    for (const m of type.members.slice(0, MAX_CHILDREN)) {
      views.push(await this.view(this.member(val, m, m.name ?? '<anonymous>')))
    }
    if (type.members.length > MAX_CHILDREN) views.push(more(type.members.length - MAX_CHILDREN))
    return views
  }

  private async elementViews(val: Val, type: CType & { kind: 'array' }): Promise<ValueView[]> {
    const count = type.counts[0] ?? 0
    const inner: TypeRef =
      type.counts.length > 1 ? { kind: 'array', elem: type.elem, counts: type.counts.slice(1) } : type.elem
    const views: ValueView[] = []
    for (let i = 0; i < Math.min(count, MAX_CHILDREN); i++) {
      views.push(await this.view(this.element(val, inner, i, `[${i}]`)))
    }
    if (count > MAX_CHILDREN) views.push(more(count - MAX_CHILDREN))
    return views
  }

  /** One line of text for a value, or null when its bytes cannot be read. */
  private async text(val: Val, type: CType): Promise<string | null> {
    switch (type.kind) {
      case 'base':
      case 'enum': {
        const v = await this.scalar(val)
        if (v === null) return null
        return this.formatScalar(type, v)
      }
      case 'pointer':
        return this.pointerText(val, type)
      case 'struct':
        return '{...}'
      case 'array': {
        const count = type.counts[0] ?? 0
        if (!this.isCharArray(type)) return `[${count}]`
        const bytes = await this.bytes(val, Math.min(count, MAX_STRING))
        return bytes ? quote(bytes, count > MAX_STRING) : null
      }
      case 'function':
        return val.loc.kind === 'memory' ? this.codeLabel(Number(val.loc.addr)) : 'function'
      case 'void':
        return 'void'
      default:
        return null
    }
  }

  private formatScalar(type: CType & { kind: 'base' | 'enum' }, v: bigint): string {
    if (type.kind === 'enum') {
      const exact = type.enumerators.find((e) => e.value === v)
      return exact ? exact.name : v.toString()
    }
    switch (type.encoding) {
      case ATE.boolean:
        return v === 0n ? 'false' : 'true'
      case ATE.float: {
        const dv = new DataView(toBytes(v, type.size).buffer)
        if (type.size === 4) return String(Number(dv.getFloat32(0, true).toPrecision(9)))
        if (type.size === 8) return String(dv.getFloat64(0, true))
        return v.toString()
      }
      case ATE.signed_char:
      case ATE.unsigned_char:
        return type.size === 1 ? `${v} ${charLiteral(Number(BigInt.asUintN(8, v)))}` : v.toString()
      default:
        return v.toString()
    }
  }

  private async pointerText(val: Val, type: CType & { kind: 'pointer' }): Promise<string | null> {
    const addr = await this.scalar(val)
    if (addr === null) return null
    const hex = `0x${addr.toString(16)}`
    if (addr === 0n) return hex
    const n = Number(addr)
    const target = this.types.complete(this.types.strip(type.target))
    if (target.kind === 'function') return this.codeLabel(n)
    const label = this.target.label(n)
    let text = label ? `${hex} <${label}>` : hex
    if (target.kind === 'base' && target.size === 1 && (target.encoding === ATE.signed_char || target.encoding === ATE.unsigned_char)) {
      const s = await this.cString(n)
      if (s !== null) text += ` ${s}`
    }
    return text
  }

  private codeLabel(addr: number): string {
    const code = this.target.codeAddress(addr)
    const label = this.target.label(code)
    const hex = `0x${addr.toString(16)}`
    return label ? `${hex} <${label}>` : hex
  }

  private async cString(addr: number): Promise<string | null> {
    const bytes = await this.target.read(addr, MAX_STRING)
    if (!bytes) return null
    return quote(bytes, true)
  }

  private isCharArray(type: CType & { kind: 'array' }): boolean {
    if (type.counts.length !== 1) return false
    const elem = this.types.strip(type.elem)
    return elem.kind === 'base' && elem.size === 1 && (elem.encoding === ATE.signed_char || elem.encoding === ATE.unsigned_char)
  }
}

const none = async (): Promise<ValueView[]> => []

function more(n: number): ValueView {
  return {
    name: '…',
    typeName: '',
    text: `${n} more`,
    unavailable: true,
    expandable: false,
    children: none,
  }
}

/** A user-facing reason for a missing value. */
function describeUnavailable(reason: string): string {
  if (reason === OPTIMIZED_OUT) return '<optimized out>'
  if (reason.startsWith('cannot read')) return `can't read memory (${reason.slice('cannot read '.length)})`
  return `not available here (${reason})`
}

/** The value `offset` bytes into `parent`, as `type`. */
function at(parent: Val, offset: number, type: TypeRef, name: string): Val {
  if (parent.loc.kind === 'memory') {
    return { name, type, loc: { kind: 'memory', addr: parent.loc.addr + BigInt(offset) } }
  }
  return { name, type, loc: parent.loc, byteOffset: (parent.byteOffset ?? 0) + offset }
}

function isSigned(type: CType): boolean {
  if (type.kind === 'enum') return type.signed
  if (type.kind !== 'base') return false
  return type.encoding === ATE.signed || type.encoding === ATE.signed_char
}

function toBytes(v: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let rest = BigInt.asUintN(size * 8, v)
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function fromBytes(bytes: Uint8Array): bigint {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!)
  return v
}

/** A char as GDB prints one: `'A'`, `'\n'`, `'\001'`. */
function charLiteral(c: number): string {
  const named: Record<number, string> = {
    7: '\\a',
    8: '\\b',
    9: '\\t',
    10: '\\n',
    11: '\\v',
    12: '\\f',
    13: '\\r',
    39: "\\'",
    92: '\\\\',
  }
  if (named[c]) return `'${named[c]}'`
  if (c >= 0x20 && c < 0x7f) return `'${String.fromCharCode(c)}'`
  return `'\\${c.toString(8).padStart(3, '0')}'`
}

/** Bytes up to the first NUL, as a C string literal. */
function quote(bytes: Uint8Array, truncated: boolean): string {
  let end = bytes.indexOf(0)
  const complete = end >= 0
  if (end < 0) end = bytes.length
  let out = ''
  for (const c of bytes.subarray(0, end)) {
    if (c === 34) out += '\\"'
    else if (c === 92) out += '\\\\'
    else if (c === 10) out += '\\n'
    else if (c === 9) out += '\\t'
    else if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c)
    else out += `\\x${c.toString(16).padStart(2, '0')}`
  }
  return `"${out}"${!complete && truncated ? '…' : ''}`
}
