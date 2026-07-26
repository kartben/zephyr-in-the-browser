import { describe, expect, it } from 'vitest'
import {
  highlightC,
  highlightCode,
  isCLanguage,
  splitHighlightedLines,
} from './highlight'

describe('isCLanguage', () => {
  it('recognises C and header aliases', () => {
    expect(isCLanguage('c')).toBe(true)
    expect(isCLanguage('C')).toBe(true)
    expect(isCLanguage('h')).toBe(true)
    expect(isCLanguage('cpp')).toBe(true)
    expect(isCLanguage('c++')).toBe(true)
  })

  it('rejects unrelated fences', () => {
    expect(isCLanguage('')).toBe(false)
    expect(isCLanguage('console')).toBe(false)
    expect(isCLanguage('dts')).toBe(false)
    expect(isCLanguage(undefined)).toBe(false)
  })
})

describe('highlightC', () => {
  it('emits token spans for keywords and types', () => {
    const html = highlightC('int main(void) { return 0; }')
    expect(html).toContain('hljs-type')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('>return<')
    expect(html).not.toContain('<script')
  })

  it('escapes raw HTML in the source', () => {
    const html = highlightC('const char *s = "<b>";')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })
})

describe('highlightCode', () => {
  it('highlights C fences and escapes others', () => {
    expect(highlightCode('return 1;', 'c')).toContain('hljs-keyword')
    expect(highlightCode('a < b', 'console')).toBe('a &lt; b')
  })
})

describe('splitHighlightedLines', () => {
  it('keeps one fragment per source line', () => {
    const src = 'int x;\nreturn x;'
    const lines = splitHighlightedLines(highlightC(src))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('hljs-type')
    expect(lines[1]).toContain('hljs-keyword')
  })

  it('reopens spans that cross a newline', () => {
    const html =
      '<span class="hljs-comment">/* line one\n * line two */</span>'
    const lines = splitHighlightedLines(html)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('<span class="hljs-comment">/* line one</span>')
    expect(lines[1]).toBe('<span class="hljs-comment"> * line two */</span>')
  })

  it('preserves a trailing empty line', () => {
    expect(splitHighlightedLines('a\n')).toEqual(['a', ''])
  })
})
