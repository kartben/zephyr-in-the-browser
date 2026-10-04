/**
 * Placeholders in a tour's runnable shell snippets.
 *
 * A step that says "suspend the consumer" wants to hand the learner the exact
 * command, but Zephyr's `kernel thread suspend` takes a thread's address, and
 * no author can know that: it is wherever this build put the thread. So the
 * snippet names the thread and the page fills the address in.
 *
 *     kernel thread suspend ${thread:consumer}
 *     devmem ${addr:readings}
 *
 * `${thread:NAME}` is looked up in the debugger's last thread walk, falling
 * back to the `_k_thread_obj_NAME` symbol `K_THREAD_DEFINE()` leaves in the
 * image. `${addr:SYMBOL}` is a data symbol's address. Neither reads guest
 * memory, so both work while the guest runs, which is when a shell command is
 * typed.
 *
 * Pure and DOM-free, like src/tours/markdown.ts.
 */

export type PlaceholderKind = 'thread' | 'addr'

const KINDS: readonly PlaceholderKind[] = ['thread', 'addr']

function isKind(value: string): value is PlaceholderKind {
  return (KINDS as readonly string[]).includes(value)
}

export interface Placeholder {
  kind: PlaceholderKind
  /** Thread name or symbol name. */
  name: string
  /** As written, braces and all: `${thread:consumer}`. */
  raw: string
}

/** What a snippet looks names up in. */
export interface SnippetContext {
  /** The debugger's last thread walk. Empty until the guest has stopped once. */
  threads: ReadonlyArray<{ name: string; addr: number }>
  /** Data symbols from the guest image, or null with no image (the mock backend). */
  symbols: ReadonlyMap<string, { addr: number }> | null
}

/** One run of a resolved line, for rendering. */
export interface SnippetPiece {
  /** Literal text, a filled-in value, or a placeholder that did not resolve, as written. */
  text: string
  /** The placeholder this piece came from, as written, or null for literal text. */
  placeholder: string | null
  /** Why the placeholder did not resolve, or null. */
  error: string | null
}

export interface ResolvedSnippet {
  /** The text with every placeholder filled in, or null when one did not resolve. */
  text: string | null
  pieces: SnippetPiece[]
  /** One reason per placeholder that did not resolve, in order. */
  errors: string[]
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'placeholder'; placeholder: Placeholder }
  | { kind: 'malformed'; raw: string; problem: string }

const SYMBOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function classify(raw: string): Token {
  const inner = raw.slice(2, -1)
  const colon = inner.indexOf(':')
  const kind = (colon < 0 ? inner : inner.slice(0, colon)).trim()
  const name = colon < 0 ? '' : inner.slice(colon + 1).trim()
  if (!isKind(kind)) {
    return {
      kind: 'malformed',
      raw,
      problem: `\`${raw}\` is not a placeholder (\`\${thread:NAME}\` or \`\${addr:SYMBOL}\`)`,
    }
  }
  if (name === '') {
    return {
      kind: 'malformed',
      raw,
      problem: `\`${raw}\` names no ${kind === 'thread' ? 'thread' : 'symbol'}`,
    }
  }
  if (kind === 'addr' && !SYMBOL_NAME.test(name)) {
    return { kind: 'malformed', raw, problem: `\`${raw}\`: \`${name}\` is not a symbol name` }
  }
  return { kind: 'placeholder', placeholder: { kind, name, raw } }
}

/** Split text into literal runs and placeholders. A placeholder never spans a line. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < text.length) {
    const open = text.indexOf('${', at)
    if (open < 0) {
      tokens.push({ kind: 'text', text: text.slice(at) })
      break
    }
    if (open > at) tokens.push({ kind: 'text', text: text.slice(at, open) })
    const eol = text.indexOf('\n', open)
    const end = eol < 0 ? text.length : eol
    const close = text.indexOf('}', open + 2)
    if (close < 0 || close > end) {
      const raw = text.slice(open, end)
      tokens.push({ kind: 'malformed', raw, problem: `\`${raw}\` has no closing \`}\`` })
      at = end
      continue
    }
    tokens.push(classify(text.slice(open, close + 1)))
    at = close + 1
  }
  return tokens
}

/**
 * Every placeholder in `text`, plus a problem for each malformed one.
 *
 * Problems are authoring mistakes: an unknown kind, a missing name, a missing
 * brace. They can never resolve, so the tour test fails on them rather than
 * shipping a Run button that never enables.
 */
export function parsePlaceholders(text: string): { placeholders: Placeholder[]; problems: string[] } {
  const placeholders: Placeholder[] = []
  const problems: string[] = []
  for (const token of tokenize(text)) {
    if (token.kind === 'placeholder') placeholders.push(token.placeholder)
    else if (token.kind === 'malformed') problems.push(token.problem)
  }
  return { placeholders, problems }
}

function hex(addr: number): string {
  return `0x${addr.toString(16)}`
}

function lookup(placeholder: Placeholder, ctx: SnippetContext): number | null {
  const { kind, name } = placeholder
  if (kind === 'addr') return ctx.symbols?.get(name)?.addr ?? null
  const walked = ctx.threads.find((thread) => thread.name === name)
  if (walked) return walked.addr
  // K_THREAD_DEFINE(consumer, ...) defines `struct k_thread _k_thread_obj_consumer`,
  // so a statically defined thread resolves before the first walk.
  return ctx.symbols?.get(`_k_thread_obj_${name}`)?.addr ?? null
}

function reason(placeholder: Placeholder, ctx: SnippetContext): string {
  if (ctx.symbols === null && ctx.threads.length === 0) {
    return `${placeholder.raw} needs the running guest`
  }
  return placeholder.kind === 'thread'
    ? `No thread named “${placeholder.name}”`
    : `No symbol “${placeholder.name}” in this image`
}

/** Fill in every placeholder in `text`, or say why one would not fill. */
export function resolvePlaceholders(text: string, ctx: SnippetContext): ResolvedSnippet {
  const pieces: SnippetPiece[] = []
  const errors: string[] = []
  for (const token of tokenize(text)) {
    if (token.kind === 'text') {
      pieces.push({ text: token.text, placeholder: null, error: null })
      continue
    }
    if (token.kind === 'malformed') {
      pieces.push({ text: token.raw, placeholder: token.raw, error: token.problem })
      errors.push(token.problem)
      continue
    }
    const { placeholder } = token
    const addr = lookup(placeholder, ctx)
    if (addr === null) {
      const error = reason(placeholder, ctx)
      pieces.push({ text: placeholder.raw, placeholder: placeholder.raw, error })
      errors.push(error)
      continue
    }
    pieces.push({ text: hex(addr), placeholder: placeholder.raw, error: null })
  }
  return {
    text: errors.length > 0 ? null : pieces.map((piece) => piece.text).join(''),
    pieces,
    errors,
  }
}

/**
 * Whether a snippet line is a command to type.
 *
 * Blank lines are skipped, and so are `#` comments: they read naturally in a
 * shell block, but the Zephyr shell has no comment syntax and would answer one
 * with "command not found".
 */
export function isCommandLine(line: string): boolean {
  const text = line.trim()
  return text !== '' && !text.startsWith('#')
}
