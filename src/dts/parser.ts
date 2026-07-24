/**
 * Recursive-descent parser for devicetree source.
 *
 * The target input is Zephyr's `build/zephyr/zephyr.dts` — the fully flattened
 * tree the build actually used, written back out by dtlib in a normalized form
 * (no includes, no macros, integers as hex). The parser is deliberately more
 * tolerant than that: comments, decimal/octal integers, `/bits/`, parenthesized
 * integer expressions, and overlay-style `&label { ... }` fragments all parse,
 * so a hand-written overlay dropped by a user still yields a useful tree.
 *
 * What it does not do is binding-aware interpretation: `reg` is cells like any
 * other property. Meaning is layered on in query.ts and insights.ts.
 */

import { DtsParseError } from './model'
import type { DtsCell, DtsDocument, DtsNode, DtsProperty, DtsValue } from './model'

interface Token {
  kind: 'atom' | 'str' | 'punct'
  /** For 'str', the decoded value; otherwise the source text. */
  text: string
  line: number
  col: number
  /** Source offsets, for verbatim `raw` capture. */
  start: number
  end: number
}

// The tail entries only occur inside `(...)` expressions, which are evaluated
// from their source text — but the tokenizer still has to step over them.
const PUNCT = new Set([
  '{', '}', '<', '>', '[', ']', '(', ')', ';', '=', ',', ':', '&', '/',
  '*', '%', '~', '^', '|', '!',
])
/** Everything legal in node/property names and numeric atoms. `@` stays in the
 * atom so `tmp112@48` is one token; the parser splits the unit address off. */
const ATOM = /[A-Za-z0-9,._+?#@-]/

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let lineStart = 0
  const col = (at: number) => at - lineStart + 1
  const fail = (message: string, at: number): never => {
    throw new DtsParseError(message, line, col(at))
  }

  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      line++
      lineStart = ++i
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) fail('unterminated comment', i)
      for (let j = i; j < end; j++) {
        if (src[j] === '\n') {
          line++
          lineStart = j + 1
        }
      }
      i = end + 2
      continue
    }
    if (c === '"') {
      const start = i
      let value = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '0' ? '\0' : esc
          i += 2
          continue
        }
        if (src[i] === '\n') fail('unterminated string', start)
        value += src[i++]
      }
      if (i >= src.length) fail('unterminated string', start)
      i++
      tokens.push({ kind: 'str', text: value, line, col: col(start), start, end: i })
      continue
    }
    // Slash keywords — `/dts-v1/`, `/memreserve/`, `/bits/`, `/delete-node/`…
    // — are one atom each; a lone `/` (root node, path separator) is punct.
    if (c === '/') {
      const m = /^\/[A-Za-z0-9-]+\//.exec(src.slice(i, i + 32))
      if (m) {
        tokens.push({ kind: 'atom', text: m[0], line, col: col(i), start: i, end: i + m[0].length })
        i += m[0].length
        continue
      }
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', text: c, line, col: col(i), start: i, end: i + 1 })
      i++
      continue
    }
    if (ATOM.test(c)) {
      const start = i
      while (i < src.length && ATOM.test(src[i])) i++
      tokens.push({ kind: 'atom', text: src.slice(start, i), line, col: col(start), start, end: i })
      continue
    }
    fail(`unexpected character '${c}'`, i)
  }
  return tokens
}

function parseNumberAtom(text: string): number | undefined {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return parseInt(text, 16)
  if (/^0[0-7]+$/.test(text)) return parseInt(text, 8)
  if (/^[0-9]+$/.test(text)) return parseInt(text, 10)
  return undefined
}

/**
 * Minimal constant-expression evaluator for `(...)` cells. dtlib never emits
 * these, but hand-written trees use them (`<(1 << 5)>`); supporting the common
 * integer operators keeps such files from being rejected wholesale.
 */
function evalIntExpr(text: string, line: number, colAt: number): number {
  let i = 0
  const fail = (): never => {
    throw new DtsParseError(`cannot evaluate expression '(${text})'`, line, colAt)
  }
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  // Precedence climbing, lowest first: | ^ & shift additive multiplicative unary.
  const primary = (): number => {
    ws()
    if (text[i] === '(') {
      i++
      const v = expr()
      ws()
      if (text[i++] !== ')') fail()
      return v
    }
    if (text[i] === '~') return (i++, ~primary() >>> 0)
    if (text[i] === '-') return (i++, -primary())
    const m = /^(0[xX][0-9a-fA-F]+|[0-9]+)/.exec(text.slice(i))
    if (!m) fail()
    i += m![0].length
    return parseNumberAtom(m![0])!
  }
  const mul = (): number => {
    let v = primary()
    // Note the explicit undefined guard: ''.includes('') is true.
    for (ws(); text[i] !== undefined && '*/%'.includes(text[i]); ws()) {
      const op = text[i++]
      const r = primary()
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r
    }
    return v
  }
  const add = (): number => {
    let v = mul()
    for (ws(); text[i] === '+' || text[i] === '-'; ws()) {
      const op = text[i++]
      const r = mul()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const shift = (): number => {
    let v = add()
    for (ws(); text.startsWith('<<', i) || text.startsWith('>>', i); ws()) {
      const op = text.slice(i, i + 2)
      i += 2
      const r = add()
      v = op === '<<' ? (v << r) >>> 0 : v >>> r
    }
    return v
  }
  const band = (): number => {
    let v = shift()
    for (ws(); text[i] === '&' && text[i + 1] !== '&'; ws()) {
      i++
      v = (v & shift()) >>> 0
    }
    return v
  }
  const bxor = (): number => {
    let v = band()
    for (ws(); text[i] === '^'; ws()) {
      i++
      v = (v ^ band()) >>> 0
    }
    return v
  }
  const expr = (): number => {
    let v = bxor()
    for (ws(); text[i] === '|' && text[i + 1] !== '|'; ws()) {
      i++
      v = (v | bxor()) >>> 0
    }
    return v
  }
  const result = expr()
  ws()
  if (i !== text.length) fail()
  return result
}

class Parser {
  private pos = 0
  private readonly labelIndex = new Map<string, DtsNode>()

  constructor(
    private readonly src: string,
    private readonly tokens: Token[],
  ) {}

  parse(): DtsDocument {
    const root: DtsNode = { name: '/', labels: [], properties: [], children: [], parent: null }

    while (this.pos < this.tokens.length) {
      const tok = this.next()
      if (tok.kind === 'atom' && (tok.text === '/dts-v1/' || tok.text === '/plugin/')) {
        this.expectPunct(';')
        continue
      }
      if (tok.kind === 'atom' && tok.text.startsWith('/') && tok.text.endsWith('/')) {
        // /memreserve/ and any future slash statement: skip to its terminator.
        this.skipStatement()
        continue
      }
      if (tok.kind === 'punct' && tok.text === '/') {
        this.parseNodeBody(root)
        continue
      }
      if (tok.kind === 'punct' && tok.text === '&') {
        // Overlay-style fragment. When the label is already known (flattened
        // files never need this, but a self-contained overlay can), merge into
        // that node; otherwise keep the fragment as a root child, name and all.
        const target = this.parseFragmentTarget(root)
        this.parseNodeBody(target)
        continue
      }
      throw this.errorAt(tok, `expected a node, got '${tok.text}'`)
    }

    const compatIndex = new Map<string, DtsNode[]>()
    const walk = (node: DtsNode) => {
      const compat = node.properties.find((p) => p.name === 'compatible')
      for (const value of compat?.values ?? []) {
        if (value.kind !== 'string') continue
        const list = compatIndex.get(value.value)
        if (list) list.push(node)
        else compatIndex.set(value.value, [node])
      }
      node.children.forEach(walk)
    }
    walk(root)

    return { root, labelIndex: this.labelIndex, compatIndex }
  }

  private parseFragmentTarget(root: DtsNode): DtsNode {
    const tok = this.next()
    let label: string
    if (tok.kind === 'punct' && tok.text === '{') {
      // &{/path/to/node} — capture the path verbatim.
      const start = this.peek()
      let end = start
      while (!(this.peek().kind === 'punct' && this.peek().text === '}')) end = this.next()
      this.next() // '}'
      label = this.src.slice(start.start, end.end)
    } else if (tok.kind === 'atom') {
      label = tok.text
    } else {
      throw this.errorAt(tok, `expected a label after '&', got '${tok.text}'`)
    }
    return this.labelIndex.get(label) ?? this.childNamed(root, `&${label}`)
  }

  private parseNodeBody(node: DtsNode) {
    this.expectPunct('{')
    for (;;) {
      let tok = this.next()
      if (tok.kind === 'punct' && tok.text === '}') {
        this.expectPunct(';')
        return
      }

      if (tok.kind === 'atom' && tok.text.startsWith('/') && tok.text.endsWith('/')) {
        if (tok.text === '/omit-if-no-ref/') continue // annotation on the next node
        this.skipStatement() // /delete-node/, /delete-property/, …
        continue
      }

      // Labels: any number of `name:` prefixes before a node name.
      const labels: string[] = []
      while (
        tok.kind === 'atom' &&
        this.peek().kind === 'punct' &&
        this.peek().text === ':'
      ) {
        labels.push(tok.text)
        this.next() // ':'
        tok = this.next()
      }

      if (tok.kind !== 'atom') throw this.errorAt(tok, `expected a name, got '${tok.text}'`)
      const name = tok.text
      const after = this.peek()

      if (after.kind === 'punct' && after.text === '{') {
        const child = this.childNamed(node, name)
        for (const label of labels) {
          if (!child.labels.includes(label)) child.labels.push(label)
          this.labelIndex.set(label, child)
        }
        this.parseNodeBody(child)
        continue
      }

      if (labels.length > 0) throw this.errorAt(after, 'labels are only valid on nodes')

      if (after.kind === 'punct' && after.text === ';') {
        this.next()
        this.setProperty(node, { name, raw: '', values: [] })
        continue
      }

      if (after.kind === 'punct' && after.text === '=') {
        this.next()
        const rawStart = this.peek().start
        const values = this.parseValues()
        const semi = this.expectPunct(';')
        this.setProperty(node, { name, raw: this.src.slice(rawStart, semi.start).trim(), values })
        continue
      }

      throw this.errorAt(after, `expected '{', '=' or ';' after '${name}'`)
    }
  }

  /** Merge semantics: reopening a node name extends the existing node. */
  private childNamed(parent: DtsNode, name: string): DtsNode {
    const existing = parent.children.find((c) => c.name === name)
    if (existing) return existing
    const at = name.indexOf('@')
    const child: DtsNode = {
      name,
      labels: [],
      unitAddress: at === -1 ? undefined : name.slice(at + 1),
      properties: [],
      children: [],
      parent,
    }
    parent.children.push(child)
    return child
  }

  /** Redefined properties keep the last value, like dtc. */
  private setProperty(node: DtsNode, prop: DtsProperty) {
    const i = node.properties.findIndex((p) => p.name === prop.name)
    if (i === -1) node.properties.push(prop)
    else node.properties[i] = prop
  }

  private parseValues(): DtsValue[] {
    const values: DtsValue[] = []
    for (;;) {
      values.push(this.parseValue())
      if (this.peek().kind === 'punct' && this.peek().text === ',') {
        this.next()
        continue
      }
      return values
    }
  }

  private parseValue(): DtsValue {
    const tok = this.next()

    if (tok.kind === 'str') return { kind: 'string', value: tok.text }

    if (tok.kind === 'atom' && tok.text === '/bits/') {
      this.next() // the width; cells below are numbers either way
      return this.parseValue()
    }

    if (tok.kind === 'punct' && tok.text === '<') {
      const cells: DtsCell[] = []
      for (;;) {
        const cell = this.next()
        if (cell.kind === 'punct' && cell.text === '>') return { kind: 'cells', cells }
        cells.push(this.parseCell(cell))
      }
    }

    if (tok.kind === 'punct' && tok.text === '[') {
      const bytes: number[] = []
      for (;;) {
        const b = this.next()
        if (b.kind === 'punct' && b.text === ']') return { kind: 'bytes', bytes }
        if (b.kind !== 'atom' || !/^[0-9a-fA-F]+$/.test(b.text) || b.text.length % 2 !== 0) {
          throw this.errorAt(b, `expected hex bytes, got '${b.text}'`)
        }
        for (let i = 0; i < b.text.length; i += 2) {
          bytes.push(parseInt(b.text.slice(i, i + 2), 16))
        }
      }
    }

    if (tok.kind === 'punct' && tok.text === '&') {
      // A bare reference value. dtlib flattens `x = &{/path}` to a plain path
      // string, so representing the by-path form the same way keeps the two
      // spellings interchangeable for consumers (aliases, chosen).
      const ref = this.parseRef()
      return ref.kind === 'ref' ? { kind: 'ref', label: ref.label } : { kind: 'string', value: ref.path }
    }

    throw this.errorAt(tok, `expected a value, got '${tok.text}'`)
  }

  private parseCell(tok: Token): DtsCell {
    if (tok.kind === 'punct' && tok.text === '&') return this.parseRef()
    if (tok.kind === 'punct' && tok.text === '(') {
      // Collect the balanced source text and evaluate it as an integer.
      let depth = 1
      let end = tok
      while (depth > 0) {
        end = this.next()
        if (end.kind === 'punct' && end.text === '(') depth++
        if (end.kind === 'punct' && end.text === ')') depth--
      }
      const text = this.src.slice(tok.end, end.start)
      return { kind: 'number', value: evalIntExpr(text, tok.line, tok.col) }
    }
    if (tok.kind === 'atom') {
      const value = parseNumberAtom(tok.text)
      if (value !== undefined) return { kind: 'number', value }
    }
    throw this.errorAt(tok, `expected a cell, got '${tok.text}'`)
  }

  private parseRef(): { kind: 'ref'; label: string } | { kind: 'pathref'; path: string } {
    const tok = this.next()
    if (tok.kind === 'punct' && tok.text === '{') {
      const start = this.peek()
      let end = start
      while (!(this.peek().kind === 'punct' && this.peek().text === '}')) end = this.next()
      this.next() // '}'
      return { kind: 'pathref', path: this.src.slice(start.start, end.end) }
    }
    if (tok.kind === 'atom') return { kind: 'ref', label: tok.text }
    throw this.errorAt(tok, `expected a label after '&', got '${tok.text}'`)
  }

  private skipStatement() {
    while (this.pos < this.tokens.length) {
      const tok = this.next()
      if (tok.kind === 'punct' && tok.text === ';') return
    }
  }

  private peek(): Token {
    const tok = this.tokens[this.pos]
    if (!tok) throw new DtsParseError('unexpected end of file', this.lastLine(), 1)
    return tok
  }

  private next(): Token {
    const tok = this.tokens[this.pos++]
    if (!tok) throw new DtsParseError('unexpected end of file', this.lastLine(), 1)
    return tok
  }

  private expectPunct(text: string): Token {
    const tok = this.next()
    if (tok.kind !== 'punct' || tok.text !== text) {
      throw this.errorAt(tok, `expected '${text}', got '${tok.text}'`)
    }
    return tok
  }

  private errorAt(tok: Token, message: string): DtsParseError {
    return new DtsParseError(message, tok.line, tok.col)
  }

  private lastLine(): number {
    return this.tokens[this.tokens.length - 1]?.line ?? 1
  }
}

/** Parse devicetree source into a document; throws DtsParseError on bad input. */
export function parseDts(src: string): DtsDocument {
  return new Parser(src, tokenize(src)).parse()
}
