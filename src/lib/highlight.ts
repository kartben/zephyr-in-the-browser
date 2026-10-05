/**
 * Syntax highlighting for C (and close cousins) and devicetree shown in the UI.
 *
 * highlight.js is registered with only those two grammars so the bundle stays
 * small. Callers get escaped HTML, safe to inject via dangerouslySetInnerHTML
 * when the source is our own shipped samples / tour step bodies.
 */

import type { HLJSApi, Language } from 'highlight.js'
import hljs from 'highlight.js/lib/core'
import c from 'highlight.js/lib/languages/c'
import dts from 'highlight.js/lib/languages/dts'

/*
 * highlight.js's devicetree grammar spells a property name `[a-z][a-z-,]+` and
 * takes every `#` for the preprocessor. A built zephyr.dts has `pinctrl-0` and
 * `#gpio-cells`, and no preprocessor left. Of two rules that match at the same
 * place, highlight.js takes the first, so these two go ahead of the grammar's.
 */
function zephyrDts(api: HLJSApi): Language {
  const lang = dts(api)
  lang.contains = [
    { match: [/#?[a-zA-Z][\w,.+?-]*/, /\s*/, /=/], scope: { 1: 'attr', 3: 'operator' } },
    { match: /#?[a-zA-Z][\w,.+?-]*(?=\s*;)/, scope: 'attr' },
    ...(lang.contains ?? []),
  ]
  return lang
}

hljs.registerLanguage('c', c)
hljs.registerLanguage('dts', zephyrDts)

/** Fence / file languages we treat as C. */
const C_ALIASES = new Set(['c', 'h', 'cpp', 'cc', 'cxx', 'c++', 'hpp'])

/** Fence / file languages we treat as devicetree. */
const DTS_ALIASES = new Set(['dts', 'dtsi', 'overlay', 'devicetree'])

export function isCLanguage(language: string | undefined | null): boolean {
  if (!language) return false
  return C_ALIASES.has(language.trim().toLowerCase())
}

/** The grammar for a fence / file language, or null to leave it plain. */
export function grammarFor(language: string | undefined | null): 'c' | 'dts' | null {
  if (isCLanguage(language)) return 'c'
  if (language && DTS_ALIASES.has(language.trim().toLowerCase())) return 'dts'
  return null
}

/**
 * Highlight `code` as C. Returns escaped HTML with `<span class="hljs-…">`
 * wrappers. On failure (corrupt grammar input), returns escaped plain text.
 */
export function highlightC(code: string): string {
  return highlightWith('c', code)
}

/**
 * Highlight when the fence language is a C or devicetree alias; otherwise
 * return escaped plain text so other fences stay readable and safe.
 */
export function highlightCode(code: string, language: string): string {
  const grammar = grammarFor(language)
  return grammar ? highlightWith(grammar, code) : escapeHtml(code)
}

function highlightWith(grammar: 'c' | 'dts', code: string): string {
  try {
    return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
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
