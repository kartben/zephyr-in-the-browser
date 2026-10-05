/**
 * Which expression a hover over a line of source asks about.
 *
 * This is VS Code's own rule, from `getExactExpressionStartAndEnd()` in
 * src/vs/workbench/contrib/debug/common/debugUtils.ts (MIT License, Copyright
 * (c) Microsoft Corporation), which VS Code falls back on when the language has
 * no provider of its own. It takes the run of characters around the pointer
 * that are not operators or brackets, so `evt->code` stays together and
 * `printk(` does not, then cuts it after the word under the pointer: hovering
 * `evt` in `evt->code` asks about `evt`, hovering `code` asks about
 * `evt->code`.
 *
 * Columns are 0-based character offsets here, where VS Code's are 1-based
 * editor positions.
 */

export interface HoverExpression {
  /** The text to evaluate. */
  text: string
  /** Its first column on the line, and one past its last. */
  start: number
  end: number
}

export function hoverExpression(line: string, column: number): HoverExpression | null {
  // Any character except a set of characters which often break interesting
  // sub-expressions; `->` is let back in.
  const expression = /([^()[\]{}<>\s+\-/%~#^;=|,`!]|->)+/g
  for (let m = expression.exec(line); m; m = expression.exec(line)) {
    const start = m.index
    if (column < start || column >= start + m[0].length) continue
    // Cut after the word under the pointer, or the first one after it.
    const word = /(\w|\p{L})+/gu
    for (let w = word.exec(m[0]); w; w = word.exec(m[0])) {
      if (start + w.index + w[0].length > column) {
        const text = m[0].slice(0, w.index + w[0].length)
        return { text, start, end: start + text.length }
      }
    }
    return null
  }
  return null
}
