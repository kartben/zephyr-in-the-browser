import { describe, expect, it } from 'vitest'
import { parseDirectives, parseTour, parseWatch } from '@/tours/parse'

describe('parseDirectives', () => {
  it('reads scalars, lists and one level of mapping', () => {
    const { values, problems } = parseDirectives(
      [
        'at: main.c:12',
        'watch:',
        '  - pin = led+1p as u8',
        '  - name = **led as string',
        'memory:',
        '  at: led',
        '  len: 16',
      ].join('\n'),
    )
    expect(problems).toEqual([])
    expect(values.get('at')).toBe('main.c:12')
    expect(values.get('watch')).toEqual(['pin = led+1p as u8', 'name = **led as string'])
    expect(values.get('memory')).toEqual({ at: 'led', len: '16' })
  })

  it('drops trailing comments but keeps quoted text whole', () => {
    const { values } = parseDirectives(['mark: 0..4 # the port pointer', 'note: "a # sign"'].join('\n'))
    expect(values.get('mark')).toBe('0..4')
    expect(values.get('note')).toBe('a # sign')
  })

  it('reports a line that is not a directive rather than guessing', () => {
    const { problems } = parseDirectives('this is prose\n  stray')
    expect(problems).toHaveLength(2)
  })
})

describe('parseWatch', () => {
  it('splits label, expression and format', () => {
    expect(parseWatch('pin = led+1p as u8')).toEqual({
      label: 'pin',
      expr: 'led+1p',
      format: 'u8',
    })
  })

  it('defaults the format and allows an anonymous row', () => {
    expect(parseWatch('*led')).toEqual({ label: null, expr: '*led', format: 'u32' })
  })

  it('does not mistake a comparison for a label', () => {
    expect(parseWatch('counter >= 4 as u8')?.expr).toBe('counter >= 4')
  })
})

const TOUR = `---
tour: Blinky, explained
sample: samples/basic/blinky
---

An introduction.

## First step

\`\`\`tour
at: main
panel: gpio
watch:
  - pin = led+1p as u8
memory:
  at: led
  len: 16
  mark: 0..1p
  note: the controller pointer
\`\`\`

Prose about **the first step**.

\`\`\`c
static const struct gpio_dt_spec led;
\`\`\`

## Second step

\`\`\`tour
at: main.c:/toggle/
when: hits % 40 == 0
repeat: yes
stop: no
threads: yes
registers: pc, sp
\`\`\`

More prose.
`

describe('parseTour', () => {
  const doc = parseTour(TOUR)

  it('reads the front matter and the intro', () => {
    expect(doc.title).toBe('Blinky, explained')
    expect(doc.sample).toBe('samples/basic/blinky')
    expect(doc.intro).toBe('An introduction.')
    expect(doc.problems).toEqual([])
  })

  it('makes one step per heading, in file order', () => {
    expect(doc.steps.map((s) => s.title)).toEqual(['First step', 'Second step'])
    expect(doc.steps.map((s) => s.index)).toEqual([0, 1])
  })

  it('keeps the step body as Markdown, fenced blocks and all', () => {
    expect(doc.steps[0]!.body).toContain('Prose about **the first step**.')
    expect(doc.steps[0]!.body).toContain('```c')
    // The stage directions are not prose and must not be rendered as any.
    expect(doc.steps[0]!.body).not.toContain('at: main')
  })

  it('reads the stage directions', () => {
    const [first, second] = doc.steps
    expect(first!.at).toBe('main')
    expect(first!.panel).toBe('gpio')
    expect(first!.stop).toBe(true)
    expect(first!.repeat).toBe(false)
    expect(first!.watch).toEqual([{ label: 'pin', expr: 'led+1p', format: 'u8' }])
    expect(first!.memory).toEqual({
      at: 'led',
      len: 16,
      mark: { start: '0', end: '1p' },
      note: 'the controller pointer',
    })

    expect(second!.at).toBe('main.c:/toggle/')
    expect(second!.when).toBe('hits % 40 == 0')
    expect(second!.repeat).toBe(true)
    expect(second!.stop).toBe(false)
    expect(second!.threads).toBe(true)
    expect(second!.registers).toEqual(['pc', 'sp'])
  })

  it('drops a step with no anchor and says why', () => {
    const doc = parseTour('## Nowhere\n\n```tour\npanel: gpio\n```\n\nProse.\n')
    expect(doc.steps).toEqual([])
    expect(doc.problems[0]).toContain('no `at:`')
  })

  it('rejects a format it cannot read', () => {
    const doc = parseTour('## Step\n\n```tour\nat: main\nwatch:\n  - x = led as u37\n```\n')
    expect(doc.steps[0]!.watch).toEqual([])
    expect(doc.problems[0]).toContain('u37')
  })

  it('reads a document that is not a tour as having no steps', () => {
    expect(parseTour('<!doctype html>\n<html></html>').steps).toEqual([])
    expect(parseTour('').steps).toEqual([])
  })
})
