import { describe, expect, it } from 'vitest'
import {
  grammarFor,
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

describe('grammarFor', () => {
  it('maps C and devicetree aliases, and nothing else', () => {
    expect(grammarFor('h')).toBe('c')
    expect(grammarFor('dts')).toBe('dts')
    expect(grammarFor('DTSI')).toBe('dts')
    expect(grammarFor('overlay')).toBe('dts')
    expect(grammarFor('console')).toBeNull()
    expect(grammarFor(undefined)).toBeNull()
  })
})

describe('highlightCode as devicetree', () => {
  const dts = (code: string) => highlightCode(code, 'dts')

  it('colours labels, nodes, properties, references, cells and strings', () => {
    const html = dts('\tbutton0: button_0 {\n\t\tgpios = < &gpio0 0x0 0x11 >;\n\t\tlabel = "SW0";\n\t};')
    expect(html).toContain('<span class="hljs-symbol">\tbutton0:</span>')
    expect(html).toContain('<span class="hljs-title class_">button_0</span>')
    expect(html).toContain('<span class="hljs-attr">gpios</span>')
    expect(html).toContain('<span class="hljs-variable">&amp;gpio0</span>')
    expect(html).toContain('<span class="hljs-number">0x11</span>')
    expect(html).toContain('<span class="hljs-string">&quot;SW0&quot;</span>')
  })

  it('reads Zephyr property names as properties, not preprocessor lines', () => {
    expect(dts('#gpio-cells = < 0x2 >;')).toContain('<span class="hljs-attr">#gpio-cells</span>')
    expect(dts('#gpio-cells = < 0x2 >;')).not.toContain('hljs-meta')
    expect(dts('pinctrl-0 = < &uart0_default >;')).toContain('<span class="hljs-attr">pinctrl-0</span>')
    expect(dts('zephyr,code = < 0xb >;')).toContain('<span class="hljs-attr">zephyr,code</span>')
    expect(dts('gpio-controller;')).toContain('<span class="hljs-attr">gpio-controller</span>')
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
