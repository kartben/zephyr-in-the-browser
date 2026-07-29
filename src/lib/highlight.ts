/**
 * Syntax highlighting for C (and close cousins) shown in the UI.
 *
 * highlight.js is registered with only the C grammar so the bundle stays small.
 * Callers get escaped HTML — safe to inject via dangerouslySetInnerHTML when
 * the source is our own shipped samples / tour step bodies.
 */

import hljs from 'highlight.js/lib/core'
import c from 'highlight.js/lib/languages/c'

hljs.registerLanguage('c', c)

/** Fence / file languages we treat as C. */
const C_ALIASES = new Set(['c', 'h', 'cpp', 'cc', 'cxx', 'c++', 'hpp'])

export function isCLanguage(language: string | undefined | null): boolean {
  if (!language) return false
  return C_ALIASES.has(language.trim().toLowerCase())
}

/**
 * Highlight `code` as C. Returns escaped HTML with `<span class="hljs-…">`
 * wrappers. On failure (corrupt grammar input), returns escaped plain text.
 */
export function highlightC(code: string): string {
  try {
    return hljs.highlight(code, { language: 'c', ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}

/**
 * Highlight when the fence language is a C alias; otherwise return escaped
 * plain text so non-C fences stay readable and safe.
 */
export function highlightCode(code: string, language: string): string {
  if (isCLanguage(language)) return highlightC(code)
  return escapeHtml(code)
}

/**
 * Split highlight.js HTML into one HTML fragment per source line, closing and
 * re-opening spans that cross newlines so each line is valid markup on its own.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  let current = ''
  const stack: string[] = []

  const flushLine = () => {
    lines.push(current + '</span>'.repeat(stack.length))
    current = stack.join('')
  }

  const tagRe = /<\/?span\b[^>]*>/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  const appendText = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') flushLine()
      else current += text[i]
    }
  }

  while ((match = tagRe.exec(html)) !== null) {
    appendText(html.slice(lastIndex, match.index))
    const tag = match[0]
    if (/^<\/span/i.test(tag)) {
      current += tag
      stack.pop()
    } else {
      current += tag
      stack.push(tag)
    }
    lastIndex = match.index + tag.length
  }
  appendText(html.slice(lastIndex))
  lines.push(current + '</span>'.repeat(stack.length))
  return lines
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
