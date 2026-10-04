/**
 * Where a C function's definition sits in a source file, found in the text.
 *
 * A pattern anchor matches the first line it can, and a sample often has the
 * same line in two functions: `BUS_UNLOCK();` in the aggregator and in the
 * storage thread. `main.c:storage_entry/BUS_UNLOCK/` searches only the body of
 * `storage_entry()`, and this is what says where that body is. It reads the
 * same shipped text the pattern is searched in, so the two cannot disagree.
 */

/**
 * The text with comments, strings and character literals blanked to spaces,
 * newlines kept, so offsets and line numbers still line up with the original
 * and a brace or a name inside one of them is not code.
 */
function blankNonCode(text: string): string {
  const out = text.split('')
  let i = 0
  const blank = (to: number) => {
    for (; i < to; i++) if (out[i] !== '\n') out[i] = ' '
  }
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i)
      blank(end < 0 ? text.length : end)
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      blank(end < 0 ? text.length : end + 2)
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      blank(Math.min(j + 1, text.length))
    } else {
      i++
    }
  }
  return out.join('')
}

/** The index of the bracket that closes the one at `open`, or -1. */
function closing(code: string, open: number, opener: string, closer: string): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === opener) depth++
    else if (code[i] === closer && --depth === 0) return i
  }
  return -1
}

function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++
  return line
}

/**
 * The lines of `name`'s definition, as 0-based indexes into `lines`: from the
 * line its name is on to the line of its closing brace. A prototype or a call
 * is not a definition (what follows its `)` is not `{`), and neither is a
 * member access (`ops->name(`). Null when the file defines no such function;
 * the first definition wins when it defines several (`#if` variants).
 */
export function functionLines(
  lines: readonly string[],
  name: string,
): { first: number; last: number } | null {
  if (!/^[A-Za-z_]\w*$/.test(name)) return null
  const text = lines.join('\n')
  const code = blankNonCode(text)
  for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const at = m.index
    if (code[at - 1] === '.' || (code[at - 1] === '>' && code[at - 2] === '-')) continue
    const close = closing(code, at + m[0].length - 1, '(', ')')
    if (close < 0) continue
    let body = close + 1
    while (body < code.length && /\s/.test(code[body]!)) body++
    if (code[body] !== '{') continue
    const end = closing(code, body, '{', '}')
    if (end < 0) return null
    return { first: lineAt(text, at), last: lineAt(text, end) }
  }
  return null
}
