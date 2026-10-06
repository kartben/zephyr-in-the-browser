import { describe, expect, it } from 'vitest'
import { isRunnableShell, parseMarkdown, type InlineSpan } from './markdown'

/** Flatten a single-paragraph body down to its spans. */
function spans(body: string): InlineSpan[] {
  const blocks = parseMarkdown(body)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].kind).toBe('paragraph')
  return blocks[0].kind === 'paragraph' ? blocks[0].spans : []
}

describe('inline', () => {
  it('reads inline code', () => {
    expect(spans('call `gpio_pin_toggle_dt()` here')).toEqual([
      { kind: 'text', text: 'call ' },
      { kind: 'code', text: 'gpio_pin_toggle_dt()' },
      { kind: 'text', text: ' here' },
    ])
  })

  it('reads bold and italic', () => {
    expect(spans('**active**, not *high*')).toEqual([
      { kind: 'strong', text: 'active' },
      { kind: 'text', text: ', not ' },
      { kind: 'em', text: 'high' },
    ])
  })

  it('leaves asterisks inside code alone', () => {
    // Backticks are how an annotation quotes an API, so they win.
    expect(spans('`a * b * c`')).toEqual([{ kind: 'code', text: 'a * b * c' }])
  })

  it('reads links', () => {
    expect(spans('see [the docs](https://docs.zephyrproject.org/)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the docs', href: 'https://docs.zephyrproject.org/' },
    ])
  })

  it('renders an unsafe scheme as inert text', () => {
    // The href is the only value here the browser would act on.
    const result = spans('[click](javascript:alert(1))')
    expect(result.every((s) => s.kind === 'text')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('"link"')
  })

  it('treats raw HTML as text', () => {
    // Nothing here can emit markup, so this is structural, not sanitising.
    const result = spans('<img src=x onerror=alert(1)>')
    expect(result).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('leaves an unclosed marker literal', () => {
    expect(spans('a ** dangling')).toEqual([{ kind: 'text', text: 'a ** dangling' }])
  })
})

describe('blocks', () => {
  it('splits paragraphs on blank lines and soft-wraps within them', () => {
    // Authors wrap comment blocks at 80 columns; that must not force breaks.
    expect(parseMarkdown('one\nstill one\n\ntwo')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one still one' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'two' }] },
    ])
  })

  it('reads a paragraph of only `{name}` as the place for a view', () => {
    expect(parseMarkdown('Above.\n\n{threads}\n\nBelow.')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Above.' }] },
      { kind: 'slot', name: 'threads' },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Below.' }] },
    ])
  })

  it('leaves braces in running text alone', () => {
    expect(parseMarkdown('{threads} and more')[0]!.kind).toBe('paragraph')
    expect(parseMarkdown('a line\n{threads}')[0]!.kind).toBe('paragraph')
    expect(parseMarkdown('{Threads}')[0]!.kind).toBe('paragraph')
  })

  it('reads bullet lists', () => {
    expect(parseMarkdown('- first\n- `second`')).toEqual([
      {
        kind: 'list',
        items: [[{ kind: 'text', text: 'first' }], [{ kind: 'code', text: 'second' }]],
      },
    ])
  })

  it('reads fenced code blocks and keeps their indentation', () => {
    expect(parseMarkdown('```c\nint main(void)\n{\n\treturn 0;\n}\n```')).toEqual([
      { kind: 'codeblock', language: 'c', text: 'int main(void)\n{\n\treturn 0;\n}' },
    ])
  })

  it('does not treat a fence as a paragraph continuation', () => {
    const blocks = parseMarkdown('intro\n```\ncode\n```\nafter')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'codeblock', 'paragraph'])
  })

  it('closes an unterminated fence at end of input', () => {
    expect(parseMarkdown('```\ncode')).toEqual([
      { kind: 'codeblock', language: '', text: 'code' },
    ])
  })

  it('returns nothing for an empty body', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('\n\n  \n')).toEqual([])
  })
})

describe('isRunnableShell', () => {
  it('runs `shell` blocks only', () => {
    expect(isRunnableShell('shell')).toBe(true)
    expect(isRunnableShell('Shell')).toBe(true)
    // Terminal transcripts, prompts and output included, are never typed in.
    for (const language of ['sh', 'console', 'bash', 'c', '']) {
      expect(isRunnableShell(language)).toBe(false)
    }
  })
})

describe('comments', () => {
  it('drops HTML comments the way GitHub hides them, but not quoted ones', () => {
    // An author's note to the next author belongs in the file, not on the card.
    // A comment written as code is the subject of the prose, so it stays, and
    // one that never closes stays too rather than eating the rest of the step.
    const body = [
      'The ring is full. <!-- engine-gap: check the count -->',
      '<!-- a note',
      '   over two lines -->',
      'Nothing else gets in.',
      '',
      'Write `<!-- this -->` to hide a line.',
      '',
      '```html',
      '<!-- shown -->',
      '```',
      '',
      'Tail <!-- never closed',
    ].join('\n')
    expect(parseMarkdown(body)).toEqual([
      {
        kind: 'paragraph',
        spans: [{ kind: 'text', text: 'The ring is full. Nothing else gets in.' }],
      },
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'Write ' },
          { kind: 'code', text: '<!-- this -->' },
          { kind: 'text', text: ' to hide a line.' },
        ],
      },
      { kind: 'codeblock', language: 'html', text: '<!-- shown -->' },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'Tail <!-- never closed' }] },
    ])
  })
})
