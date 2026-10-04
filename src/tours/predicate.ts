/**
 * Predicates: a comparison a tour makes against the guest.
 *
 *     alarms_lost as u32 == 1     a counter, read as a watch row would read it
 *     $arg0 == readings           an argument against an address, neither read
 *     ticks as i32 < 0            signed, so a negative count is below zero
 *
 * Each side is an expression from src/tours/expr.ts. With `as fmt` it is read
 * the way a `watch:` row reads it; without, it is the number the expression
 * comes to, which for a symbol is where it lives and for a register is what it
 * holds. A bare number, `true` or `false` is itself. The comparison is on whole
 * numbers, so a signed format that reads -1 is below 0 and not equal to
 * 0xffffffff.
 *
 * A step's `check:` rows are predicates, and so, later, are the state
 * conditions a `when:` can wait for: the reads and the verdict are the same
 * question asked at a different moment. Pure and DOM-free, like expr.ts, so
 * both are testable without a debugger.
 */

import {
  FORMATS,
  evalValue,
  expressionError,
  expressionNames,
  isKnownFormat,
  isNumberFormat,
  type ExpressionNames,
  type TourTarget,
  type ValueResult,
} from '@/tours/expr'

export const COMPARE_OPS = ['==', '!=', '<', '<=', '>', '>='] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

/** One side of a comparison. */
export interface Operand {
  /** The expression as written, or the number. */
  expr: string
  /** How to read it (`u32`, `ptr`, …), or null for the number the expression is. */
  format: string | null
  /** A bare number is itself: nothing to resolve and nothing to read. */
  literal: bigint | null
}

export interface PredicateSpec {
  /** The row as written, for the card and for problems. */
  text: string
  lhs: Operand
  op: CompareOp
  rhs: Operand
}

export type PredicateParse = { ok: true; predicate: PredicateSpec } | { ok: false; error: string }

export interface PredicateResult {
  /** The comparison held. Never true when a side could not be read. */
  pass: boolean
  /** Why a side has no value (a missing symbol, a failed read), or null when both were read. */
  error: string | null
  /**
   * Each side's number, and how the card shows it: the value read, the number
   * as written, or why there is none.
   */
  lhs: ValueResult
  rhs: ValueResult
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** Longest first, so `<=` is not read as `<` followed by stray text. */
const OPERATOR = /==|!=|<=|>=|<|>/g

/** A bare number: decimal or hex, optionally negative. */
const LITERAL = /^(-)?\s*(0[xX][0-9a-fA-F]+|\d+)$/

function parseLiteral(text: string): bigint | null {
  if (text === 'true') return 1n
  if (text === 'false') return 0n
  const number = LITERAL.exec(text)
  if (!number) return null
  const magnitude = BigInt(number[2]!)
  return number[1] ? -magnitude : magnitude
}

function parseOperand(
  raw: string,
  side: string,
): { ok: true; operand: Operand } | { ok: false; error: string } {
  let expr = raw.trim()
  let format: string | null = null
  const as = /(?:^|\s+)as\s+([A-Za-z][A-Za-z0-9:_]*)$/.exec(expr)
  if (as) {
    format = as[1]!.toLowerCase()
    expr = expr.slice(0, as.index).trim()
  }
  if (expr === '') return { ok: false, error: `has nothing ${side}` }
  if (format !== null && !isKnownFormat(format)) {
    return { ok: false, error: `\`as ${format}\` is not a format (${FORMATS.join(', ')})` }
  }
  if (format !== null && !isNumberFormat(format)) {
    return { ok: false, error: `\`as ${format}\` is not a number, so it cannot be compared` }
  }
  // `0x40001000 as u32` reads what is at that address: with a format, a number
  // is an address like any other, the same as in a watch row.
  const literal = format === null ? parseLiteral(expr) : null
  if (literal === null) {
    const error = expressionError(expr)
    if (error !== null) return { ok: false, error: `\`${expr}\`: ${error}` }
  }
  return { ok: true, operand: { expr, format, literal } }
}

/**
 * Parse one row: `<expr> [as fmt] <op> <expr> [as fmt]`.
 *
 * Expressions never contain `=`, `!`, `<` or `>`, so the row has exactly one
 * comparison and finding it needs no parsing at all. Everything that can be
 * known without a guest is checked here, expressions included, so a typo fails
 * the tour's test instead of a check the reader can never pass.
 */
export function parsePredicate(raw: string): PredicateParse {
  const text = raw.trim()
  const ops = [...text.matchAll(OPERATOR)]
  if (ops.length === 0) {
    // A lone `=` is the likeliest slip, and the one worth naming.
    if (text.includes('=')) return { ok: false, error: 'compares with `=`; use `==`' }
    return { ok: false, error: `has no comparison (${COMPARE_OPS.join(', ')})` }
  }
  if (ops.length > 1) return { ok: false, error: 'has more than one comparison; write one per row' }

  const match = ops[0]!
  const op = match[0] as CompareOp
  const at = match.index!
  const lhs = parseOperand(text.slice(0, at), `to the left of \`${op}\``)
  if (!lhs.ok) return lhs
  const rhs = parseOperand(text.slice(at + op.length), `to the right of \`${op}\``)
  if (!rhs.ok) return rhs
  return { ok: true, predicate: { text, lhs: lhs.operand, op, rhs: rhs.operand } }
}

/**
 * The symbols and registers a predicate names, once each, in the order
 * written: what a build must have for it to ever hold, and what a stop must
 * carry to evaluate it. Bare numbers name nothing.
 */
export function predicateIdentifiers(predicate: PredicateSpec): ExpressionNames {
  const out: ExpressionNames = { symbols: [], registers: [] }
  for (const side of [predicate.lhs, predicate.rhs]) {
    // A side is a bare number or an expression the parser already accepted.
    const names = side.literal === null ? expressionNames(side.expr) : null
    if (!names) continue
    for (const name of names.symbols) if (!out.symbols.includes(name)) out.symbols.push(name)
    for (const name of names.registers) if (!out.registers.includes(name)) out.registers.push(name)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Evaluating
 * ------------------------------------------------------------------ */

function compare(lhs: bigint, op: CompareOp, rhs: bigint): boolean {
  switch (op) {
    case '==':
      return lhs === rhs
    case '!=':
      return lhs !== rhs
    case '<':
      return lhs < rhs
    case '<=':
      return lhs <= rhs
    case '>':
      return lhs > rhs
    case '>=':
      return lhs >= rhs
  }
}

async function evalOperand(side: Operand, target: TourTarget): Promise<ValueResult> {
  if (side.literal !== null) return { value: side.literal, text: side.expr }
  // No format means the number the expression is, which is what `dec` shows.
  return evalValue(side.expr, side.format ?? 'dec', target)
}

/**
 * Evaluate a predicate against the target. Only ever reads.
 *
 * A side that cannot be read makes the predicate false, never true: a check
 * that could not be made has not passed. `error` says which, so the card can
 * tell "not yet" from "could not look".
 */
export async function evalPredicate(
  predicate: PredicateSpec,
  target: TourTarget,
): Promise<PredicateResult> {
  const lhs = await evalOperand(predicate.lhs, target)
  const rhs = await evalOperand(predicate.rhs, target)
  if (lhs.value === null) return { pass: false, error: lhs.text, lhs, rhs }
  if (rhs.value === null) return { pass: false, error: rhs.text, lhs, rhs }
  return { pass: compare(lhs.value, predicate.op, rhs.value), error: null, lhs, rhs }
}
