/**
 * The C a hover asks about: names, `.`, `->`, `[i]`, unary `*` and `&`.
 *
 * VS Code hands the text under the mouse to GDB, and GDB parses it with a full
 * C grammar. A hover only ever produces a name followed by member accesses
 * (that is all VS Code's expression finder extracts), so this parses that
 * subset and nothing else: no arithmetic, no casts, no calls.
 */

import { ATE } from '@/debug/dwarf/constants'
import type { TypeTable, TypeRef } from '@/debug/dwarf/types'
import type { Val, ValueReader } from '@/debug/dwarf/values'

export type Expr =
  | { op: 'name'; name: string }
  | { op: 'num'; value: bigint }
  | { op: 'member'; base: Expr; name: string; arrow: boolean }
  | { op: 'index'; base: Expr; index: Expr }
  | { op: 'deref'; base: Expr }
  | { op: 'addr'; base: Expr }

/** A failure worded the way GDB words it, which is what VS Code would show. */
export class EvalError extends Error {}

type Token = { kind: 'name' | 'num' | 'punct'; text: string }

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = []
  const re = /\s*(?:([A-Za-z_]\w*)|(0[xX][0-9a-fA-F]+|\d+)[uUlL]*|(->|[.[\]()*&]))/y
  let at = 0
  while (at < src.length) {
    re.lastIndex = at
    const m = re.exec(src)
    if (!m) return src.slice(at).trim() === '' ? tokens : null
    if (m[1]) tokens.push({ kind: 'name', text: m[1] })
    else if (m[2]) tokens.push({ kind: 'num', text: m[2] })
    else tokens.push({ kind: 'punct', text: m[3]! })
    at = re.lastIndex
  }
  return tokens
}

/** Parse the subset, or null when the text is something else. */
export function parseExpression(src: string): Expr | null {
  const tokens = tokenize(src)
  if (!tokens || tokens.length === 0) return null
  let i = 0
  const peek = () => tokens[i]
  const take = (text: string) => {
    if (tokens[i]?.text === text) {
      i++
      return true
    }
    return false
  }

  const unary = (): Expr | null => {
    if (take('*')) {
      const base = unary()
      return base && { op: 'deref', base }
    }
    if (take('&')) {
      const base = unary()
      return base && { op: 'addr', base }
    }
    return postfix()
  }
  const primary = (): Expr | null => {
    const t = peek()
    if (!t) return null
    if (t.kind === 'name') {
      i++
      return { op: 'name', name: t.text }
    }
    if (t.kind === 'num') {
      i++
      return { op: 'num', value: BigInt(t.text) }
    }
    if (take('(')) {
      const inner = unary()
      return inner && take(')') ? inner : null
    }
    return null
  }
  const postfix = (): Expr | null => {
    let base = primary()
    while (base) {
      if (take('.') || (peek()?.text === '->' && take('->'))) {
        const arrow = tokens[i - 1]!.text === '->'
        const t = peek()
        if (t?.kind !== 'name') return null
        i++
        base = { op: 'member', base, name: t.text, arrow }
      } else if (take('[')) {
        const index = unary()
        if (!index || !take(']')) return null
        base = { op: 'index', base, index }
      } else {
        break
      }
    }
    return base
  }

  const expr = unary()
  return expr && i === tokens.length ? expr : null
}

export interface ExprEnv {
  reader: ValueReader
  types: TypeTable
  pointerSize: number
  /** A variable in scope, located; null when no such name is visible. */
  lookup(name: string): Promise<Val | null>
}

/** Evaluate a parsed expression. Throws {@link EvalError}. */
export async function evaluateExpression(expr: Expr, env: ExprEnv, name: string): Promise<Val> {
  const val = await evaluate(expr, env)
  return { ...val, name }
}

async function evaluate(expr: Expr, env: ExprEnv): Promise<Val> {
  const { reader, types } = env
  switch (expr.op) {
    case 'name': {
      const val = await env.lookup(expr.name)
      if (!val) throw new EvalError(`No symbol "${expr.name}" in current context.`)
      return val
    }
    case 'num': {
      const wide = expr.value > 0x7fffffffn
      const type: TypeRef = { kind: 'base', name: wide ? 'long long' : 'int', size: wide ? 8 : 4, encoding: ATE.signed }
      return { name: expr.value.toString(), type, loc: { kind: 'value', value: expr.value } }
    }
    case 'member': {
      let base = await evaluate(expr.base, env)
      if (expr.arrow) {
        const target = await pointee(base, env)
        base = target
      }
      const type = types.complete(types.strip(base.type))
      if (type.kind !== 'struct') {
        throw new EvalError(`Attempt to extract a component of a value that is not a structure${expr.arrow ? ' pointer' : ''}.`)
      }
      const m = types.member(type, expr.name)
      if (!m) throw new EvalError(`There is no member named ${expr.name}.`)
      // A member of a value with no location has none either.
      if (base.loc.kind === 'unavailable') return { name: '', type: m.type, loc: base.loc }
      return reader.member(base, m)
    }
    case 'index': {
      const base = await evaluate(expr.base, env)
      const index = await evaluate(expr.index, env)
      const i = await reader.scalar(index)
      if (i === null) throw new EvalError('Cannot read the index.')
      const type = types.strip(base.type)
      if (type.kind === 'array') {
        const elem: TypeRef =
          type.counts.length > 1 ? { kind: 'array', elem: type.elem, counts: type.counts.slice(1) } : type.elem
        return reader.element(base, elem, Number(i))
      }
      if (type.kind === 'pointer') {
        const target = await pointee(base, env)
        return reader.element(target, type.target, Number(i))
      }
      throw new EvalError('cannot subscript something of a type that is not an array or a pointer.')
    }
    case 'deref': {
      const base = await evaluate(expr.base, env)
      const type = types.strip(base.type)
      if (type.kind === 'array') return reader.element(base, type.elem, 0)
      return pointee(base, env)
    }
    case 'addr': {
      const base = await evaluate(expr.base, env)
      if (base.loc.kind !== 'memory' || base.bits) {
        throw new EvalError('Attempt to take address of value not located in memory.')
      }
      return {
        name: `&${base.name}`,
        type: { kind: 'pointer', size: env.pointerSize, target: base.type },
        loc: { kind: 'value', value: base.loc.addr },
      }
    }
  }
}

/** The value a pointer points at. */
async function pointee(base: Val, env: ExprEnv): Promise<Val> {
  const type = env.types.strip(base.type)
  if (type.kind !== 'pointer') throw new EvalError('Attempt to take contents of a non-pointer value.')
  if (base.loc.kind === 'unavailable') return { ...base, type: type.target }
  const addr = await env.reader.scalar(base)
  if (addr === null) throw new EvalError('Cannot read the pointer.')
  if (addr === 0n) throw new EvalError('Cannot access memory at address 0x0')
  return { name: `*${base.name}`, type: type.target, loc: { kind: 'memory', addr } }
}
