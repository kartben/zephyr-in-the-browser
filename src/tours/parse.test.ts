import { describe, expect, it } from 'vitest'
import { parseDirectives, parseHighlight, parseTour, parseWatch } from '@/tours/parse'

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
threads: yes
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
    expect(first!.threads).toBe(true)
    expect(second!.threads).toBe(false)
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

describe('objects', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('takes one type, several, or a block with a focus', () => {
    expect(step('objects: mutex').steps[0]!.objects).toEqual({ types: ['MUTX'], focus: null })
    expect(step('objects: semaphores, msgq').steps[0]!.objects).toEqual({
      types: ['SEM4', 'MSGQ'],
      focus: null,
    })
    expect(step('objects:\n  type: mutex\n  focus: $arg0').steps[0]!.objects).toEqual({
      types: ['MUTX'],
      focus: '$arg0',
    })
  })

  it('reads `all` as every type, which is the empty filter', () => {
    expect(step('objects: all').steps[0]!.objects).toEqual({ types: [], focus: null })
  })

  it('accepts the kernel’s own four-letter codes', () => {
    expect(step('objects: SEM4').steps[0]!.objects).toEqual({ types: ['SEM4'], focus: null })
  })

  it('reports a type it does not know rather than showing an empty list', () => {
    // An empty list is what a guest with no objects of that type looks like, so
    // a typo would be indistinguishable from a true answer at runtime.
    const doc = step('objects: mutices')
    expect(doc.steps[0]!.objects).toEqual({ types: [], focus: null })
    expect(doc.problems[0]).toContain('mutices')
  })

  it('is absent when the step does not ask for it', () => {
    expect(step('panel: gpio').steps[0]!.objects).toBeNull()
  })

  it('refuses a walk on a step that lets the machine run on', () => {
    // The walk needs the guest halted for dozens of round-trips; `stop: no` has
    // let it go long before then, so the card would hold a spinner for ever.
    const doc = step('stop: no\nobjects: mutex\nthreads: yes')
    expect(doc.steps[0]!.objects).toBeNull()
    expect(doc.steps[0]!.threads).toBe(false)
    expect(doc.problems[0]).toContain('stop: no')
  })
})

describe('highlight', () => {
  it('reads a line, a range and a pattern', () => {
    expect(parseHighlight('21')).toEqual({ kind: 'lines', start: 21, end: 21 })
    expect(parseHighlight('21-24')).toEqual({ kind: 'lines', start: 21, end: 24 })
    expect(parseHighlight('/GPIO_DT_SPEC_GET/')).toEqual({
      kind: 'pattern',
      pattern: 'GPIO_DT_SPEC_GET',
      extra: 0,
    })
    expect(parseHighlight('/^int main/ + 3')).toEqual({
      kind: 'pattern',
      pattern: '^int main',
      extra: 3,
    })
  })

  it('rejects a backwards range and anything else', () => {
    expect(parseHighlight('24-21')).toBeNull()
    expect(parseHighlight('0')).toBeNull()
    expect(parseHighlight('somewhere near the top')).toBeNull()
  })

  it('is a list on the step, and independent of `at:`', () => {
    const doc = parseTour(
      '## Step\n\n```tour\nat: main\nhighlight:\n  - 21\n  - /toggle/ + 1\n```\n\nProse.\n',
    )
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.at).toBe('main')
    expect(doc.steps[0]!.highlight).toEqual([
      { kind: 'lines', start: 21, end: 21 },
      { kind: 'pattern', pattern: 'toggle', extra: 1 },
    ])
  })

  it('reports an entry it cannot read', () => {
    const doc = parseTour('## Step\n\n```tour\nat: main\nhighlight: the top bit\n```\n\nProse.\n')
    expect(doc.steps[0]!.highlight).toEqual([])
    expect(doc.problems[0]).toContain('highlight')
  })
})

describe('trace', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('takes a tab name, and reads a plain yes as the timeline', () => {
    expect(step('trace: queues').steps[0]!.trace).toBe('queues')
    expect(step('trace: yes').steps[0]!.trace).toBe('schedule')
  })

  it('is absent unless asked for', () => {
    expect(step('panel: gpio').steps[0]!.trace).toBeNull()
    expect(step('trace: no').steps[0]!.trace).toBeNull()
  })

  it('reports a tab it does not know', () => {
    const doc = step('trace: timeline')
    expect(doc.steps[0]!.trace).toBeNull()
    expect(doc.problems[0]).toContain('timeline')
  })

  it('survives `stop: no`, because the timeline is not a walk', () => {
    // Unlike `threads:`/`objects:`, revealing the Trace row is one store write
    // and needs nothing from the stopped guest.
    const doc = step('stop: no\ntrace: yes')
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.trace).toBe('schedule')
  })
})
