import { describe, expect, it } from 'vitest'
import {
  IMPLEMENTED_KEYS,
  RESERVED_KEYS,
  parseCiAction,
  parseDirectives,
  parseHighlight,
  parseLook,
  parseTour,
  parseWatch,
  resolveHighlightSpecs,
  unknownKeys,
} from '@/tours/parse'
import m3Blinky from '@/dts/fixtures/qemu_cortex_m3_blinky.dts?raw'
import a53Blinky from '@/dts/fixtures/qemu_cortex_a53_blinky.dts?raw'

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

  it('keeps a ` #` inside a /pattern/ and still drops the comment after it', () => {
    // A format string is a fair thing to anchor on, and reading its `#` as the
    // start of a comment cut the pattern in half: the step silently vanished.
    const { values } = parseDirectives(
      [
        'at: main.c:/"tick #%u/ | main.c:57 # the producer',
        'highlight:',
        '  - /x # y/ + 1 # two lines',
      ].join('\n'),
    )
    expect(values.get('at')).toBe('main.c:/"tick #%u/ | main.c:57')
    expect(values.get('highlight')).toEqual(['/x # y/ + 1'])
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
    expect(doc.showSource).toBe(true)
    expect(doc.problems).toEqual([])
  })

  it('honours source: no in the front matter', () => {
    const tool = parseTour(
      ['---', 'tour: Page tour', 'sample: samples/basic/blinky', 'source: no', '---', '', '## Step', '', '```tour', 'at: main', '```', '', 'Prose.', ''].join(
        '\n',
      ),
    )
    expect(tool.showSource).toBe(false)
    expect(tool.problems).toEqual([])
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
    expect(first!.when).toEqual({ state: [], hits: [] })
    expect(second!.when).toEqual({ state: [], hits: ['hits % 40 == 0'] })
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

  it('keeps a fenced block in the intro out of the first step', () => {
    const doc = parseTour(
      ['Intro.', '', '```c', 'int x;', '```', '', '## Step', '', '```tour', 'at: main', '```', '', 'Prose.'].join('\n'),
    )
    expect(doc.problems).toEqual([])
    expect(doc.intro).toContain('int x;')
    expect(doc.steps[0]!.at).toBe('main')
    expect(doc.steps[0]!.body).toBe('Prose.')
  })
})

describe('outro and next', () => {
  const tour = (front: string, sections: string) =>
    parseTour(`---\ntour: T\nsample: samples/basic/blinky\n${front}---\n\n${sections}`)
  const STEP = '## Step\n\n```tour\nat: main\n```\n\nProse.\n\n'

  it('reads a last section with no tour block as the outro, not a step', () => {
    const doc = tour('', `${STEP}## What you saw\n\nA *ring* of slots.\n\nThat is all.\n`)
    expect(doc.problems).toEqual([])
    expect(doc.steps.map((s) => s.title)).toEqual(['Step'])
    expect(doc.outro).toEqual({ title: 'What you saw', body: 'A *ring* of slots.\n\nThat is all.' })
  })

  it('still reports a section with no tour block anywhere but last', () => {
    const doc = tour('', `## Forgot the block\n\nProse.\n\n${STEP}## The end\n\nBye.\n`)
    expect(doc.steps.map((s) => s.title)).toEqual(['Step'])
    expect(doc.outro?.title).toBe('The end')
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('Forgot the block')
    expect(doc.problems[0]).toContain('no `at:`')
  })

  it('has no outro when the last section is a step, which is every tour so far', () => {
    const doc = tour('', STEP)
    expect(doc.outro).toBeNull()
    expect(doc.next).toBeNull()
  })

  it('reads `next:` from the front matter', () => {
    const doc = tour('next: msgq_lab\n', `${STEP}## Done\n\nOn to part two.\n`)
    expect(doc.problems).toEqual([])
    expect(doc.next).toBe('msgq_lab')
  })

  it('takes another tour of an app as `next:`, by its full id', () => {
    const doc = tour('next: basic_button.msgq\n', `${STEP}## Done\n\nOn to the queue.\n`)
    expect(doc.problems).toEqual([])
    expect(doc.next).toBe('basic_button.msgq')
  })

  it('reports a `next:` that is not a tour id', () => {
    const doc = tour('next: samples/kernel/msg_queue\n', `${STEP}## Done\n\nBye.\n`)
    expect(doc.next).toBeNull()
    expect(doc.problems[0]).toContain('not a tour id')
  })

  it.each(['basic_button.', '.msgq', 'basic_button..msgq', 'basic_button.msgq.more'])(
    'reports `next: %s`, which has the dot in the wrong place',
    (next) => {
      const doc = tour(`next: ${next}\n`, `${STEP}## Done\n\nBye.\n`)
      expect(doc.next).toBeNull()
      expect(doc.problems[0]).toContain('not a tour id')
    },
  )

  it('reports a `next:` with no outro to offer it on', () => {
    const doc = tour('next: msgq_lab\n', STEP)
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('needs an outro')
  })
})

describe('await and do', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('reads the task and the shell lines that go with it', () => {
    const doc = step(
      'await: Stop the consumer, then watch the queue fill.\ndo:\n  - msgq consumer suspend\n  - msgq stat',
    )
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.await).toBe('Stop the consumer, then watch the queue fill.')
    expect(doc.steps[0]!.do).toEqual(['msgq consumer suspend', 'msgq stat'])
  })

  it('takes a single `do:` line whole, commas and all', () => {
    const doc = step('await: Print the stack use.\ndo: kernel thread stacks, then read')
    expect(doc.steps[0]!.do).toEqual(['kernel thread stacks, then read'])
  })

  it('is absent unless the step asks', () => {
    expect(step('panel: gpio').steps[0]!.await).toBeNull()
    expect(step('panel: gpio').steps[0]!.do).toEqual([])
  })

  it('is implemented now, not merely reserved', () => {
    expect(IMPLEMENTED_KEYS).toEqual(expect.arrayContaining(['await', 'do']))
    expect(RESERVED_KEYS).not.toEqual(expect.arrayContaining(['await']))
    expect(RESERVED_KEYS).not.toEqual(expect.arrayContaining(['do']))
  })

  it('reports `do:` lines with no `await:` to explain them', () => {
    const doc = step('do: msgq purge')
    expect(doc.problems[0]).toContain('needs an `await:`')
  })

  it('reports a `do:` block that is not a list', () => {
    const doc = step('await: Go.\ndo:\n  first: msgq purge')
    expect(doc.steps[0]!.do).toEqual([])
    expect(doc.problems[0]).toContain('`do:` takes shell lines')
  })

  it('checks placeholders in `do:` lines like a shell block', () => {
    expect(step('await: Go.\ndo: kernel thread suspend ${thread:consumer}').problems).toEqual([])
    const doc = step('await: Go.\ndo: kernel thread suspend ${thred:consumer}')
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('`do:`')
  })
})

describe('ci', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('reads the playthrough’s actions, in the order written', () => {
    const doc = step('ci:\n  - type msgq policy drop-oldest\n  - wait 500ms\n  - press sw0')
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.ci).toEqual([
      { kind: 'type', line: 'msgq policy drop-oldest' },
      { kind: 'wait', ms: 500 },
      { kind: 'press', key: 'sw0' },
    ])
  })

  it('takes a single action inline, commas and all, and needs no `await:`', () => {
    expect(step('ci: press sw0').steps[0]!.ci).toEqual([{ kind: 'press', key: 'sw0' }])
    const doc = step('ci: type log list, then stop')
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.ci).toEqual([{ kind: 'type', line: 'log list, then stop' }])
  })

  it('is absent unless the step asks, and is a key the parser knows', () => {
    expect(step('panel: gpio').steps[0]!.ci).toEqual([])
    expect(IMPLEMENTED_KEYS).toEqual(expect.arrayContaining(['ci']))
  })

  it('reads a wait in milliseconds or seconds', () => {
    expect(parseCiAction('wait 250ms')).toEqual({ ok: true, action: { kind: 'wait', ms: 250 } })
    expect(parseCiAction('wait 1.5s')).toEqual({ ok: true, action: { kind: 'wait', ms: 1500 } })
    expect(parseCiAction('WAIT 2 S')).toEqual({ ok: true, action: { kind: 'wait', ms: 2000 } })
  })

  it('reports an action it does not know, naming the step, and keeps the rest', () => {
    const doc = step('ci:\n  - push sw0\n  - press sw0')
    expect(doc.steps[0]!.ci).toEqual([{ kind: 'press', key: 'sw0' }])
    expect(doc.problems).toEqual([
      'step 1 (“Step”): `ci: push sw0` is not an action (`press <key>`, `type <line>`, `wait <duration>`)',
    ])
  })

  it('reports an action missing what it acts on', () => {
    for (const bad of ['press', 'press sw0 sw1', 'type', 'wait', 'wait 500', 'wait 0ms', 'wait 11s']) {
      const doc = step(`ci: ${bad}`)
      expect(doc.steps[0]!.ci, bad).toEqual([])
      expect(doc.problems, bad).toHaveLength(1)
      expect(doc.problems[0], bad).toContain(`\`ci: ${bad}\``)
    }
  })

  it('reports a block that is not a list of actions', () => {
    const doc = step('ci:\n  press: sw0')
    expect(doc.steps[0]!.ci).toEqual([])
    expect(doc.problems[0]).toContain('`ci:` takes actions')
  })

  it('checks placeholders in `type` lines like a shell block', () => {
    expect(step('ci: type kernel thread suspend ${thread:consumer}').problems).toEqual([])
    const doc = step('ci: type kernel thread suspend ${thred:consumer}')
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('`ci:`')
  })
})

describe('shell snippets', () => {
  const step = (fence: string, text: string) =>
    parseTour(
      `## Stop the consumer\n\n\`\`\`tour\nat: main\n\`\`\`\n\nThen watch.\n\n\`\`\`${fence}\n${text}\n\`\`\`\n`,
    )

  it('accepts both placeholder kinds', () => {
    const doc = step('shell', 'kernel thread suspend ${thread:consumer}\ndevmem ${addr:readings}')
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.body).toContain('${thread:consumer}')
  })

  it('reports a placeholder that could never resolve, naming the step', () => {
    const doc = step('shell', 'kernel thread suspend ${thred:consumer}')
    expect(doc.steps).toHaveLength(1)
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('step 1 (“Stop the consumer”)')
    expect(doc.problems[0]).toContain('${thred:consumer}')
  })

  it('reports a shell block with nothing to run', () => {
    const doc = step('shell', '# just a comment')
    expect(doc.problems[0]).toContain('no command to run')
  })

  it('leaves transcripts alone: only `shell` blocks are run', () => {
    expect(step('console', 'uart:~$ echo ${thred:x}').problems).toEqual([])
    expect(step('sh', 'echo ${HOME').problems).toEqual([])
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

  it('reads `threads:` as a switch or as the names of the threads to list', () => {
    expect(step('threads: yes').steps[0]).toMatchObject({ threads: true, threadNames: [] })
    expect(step('threads: no').steps[0]).toMatchObject({ threads: false, threadNames: [] })
    expect(step('threads: aggregator, consumer*').steps[0]).toMatchObject({
      threads: true,
      threadNames: ['aggregator', 'consumer*'],
    })
    expect(step('threads:\n  - storage\n  - Philosopher 4').steps[0]).toMatchObject({
      threads: true,
      threadNames: ['storage', 'Philosopher 4'],
    })
    // Dropped with the list on a step that lets the machine run on.
    expect(step('stop: no\nthreads: aggregator').steps[0]).toMatchObject({
      threads: false,
      threadNames: [],
    })
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

describe('when', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('reads a hit condition as it always has', () => {
    const doc = step('when: hits == 3')
    expect(doc.steps[0]!.when).toEqual({ state: [], hits: ['hits == 3'] })
    expect(doc.problems).toEqual([])
  })

  it('reads a state predicate on its own', () => {
    const doc = step('when: k_msgq(readings).used_msgs as u32 == 7')
    const when = doc.steps[0]!.when
    expect(when.hits).toEqual([])
    expect(when.state).toHaveLength(1)
    expect(when.state[0]).toMatchObject({
      text: 'k_msgq(readings).used_msgs as u32 == 7',
      lhs: { expr: 'k_msgq(readings).used_msgs', format: 'u32' },
      op: '==',
      rhs: { literal: 7n },
    })
    expect(doc.problems).toEqual([])
  })

  it('sorts a list into predicates and hit conditions, keeping the order of each', () => {
    const doc = step('when:\n  - $arg0 == readings\n  - _kernel as u32 == 0\n  - hits == 3')
    const when = doc.steps[0]!.when
    expect(when.hits).toEqual(['hits == 3'])
    expect(when.state.map((p) => p.text)).toEqual(['$arg0 == readings', '_kernel as u32 == 0'])
    expect(doc.problems).toEqual([])
  })

  it('reports an item that is neither, and drops it', () => {
    const doc = step('when:\n  - the moon is full\n  - hits == 2')
    expect(doc.steps[0]!.when).toEqual({ state: [], hits: ['hits == 2'] })
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('`when: the moon is full` has no comparison')
  })

  it('reports a predicate the parser refuses, the way `check:` does', () => {
    const doc = step('when: k_msgq(readings) as u32 == 7')
    expect(doc.steps[0]!.when.state).toEqual([])
    expect(doc.problems[0]).toContain('`when: k_msgq(readings) as u32 == 7`')
    expect(doc.problems[0]).toContain('needs a member')
  })

  it('reads `hits` against a number as the hit count, and says so when it is malformed', () => {
    // Otherwise a typo would quietly become a comparison of two addresses.
    const doc = step('when: hits >= three')
    expect(doc.steps[0]!.when).toEqual({ state: [], hits: [] })
    expect(doc.problems[0]).toContain('is not a hit condition')
  })

  it('reads a guest variable called `hits` when it has a format', () => {
    const when = step('when: hits as u32 == 3').steps[0]!.when
    expect(when.hits).toEqual([])
    expect(when.state[0]).toMatchObject({ lhs: { expr: 'hits', format: 'u32' } })
  })

  it('refuses a block', () => {
    const doc = step('when:\n  hits: 3')
    expect(doc.steps[0]!.when).toEqual({ state: [], hits: [] })
    expect(doc.problems[0]).toContain('not a block')
  })
})

describe('look and panel', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('takes one target or a list, in the order written', () => {
    expect(step('look: trace.queues').steps[0]!.look).toEqual([{ kind: 'trace', tab: 'queues' }])
    const doc = step('look:\n  - trace.net\n  - debug.objects\n  - dock.gpio')
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.look).toEqual([
      { kind: 'trace', tab: 'net' },
      { kind: 'debug', section: 'objects' },
      { kind: 'dock', panel: 'gpio' },
    ])
  })

  it('names the Timeline as the reader sees it, not as it is stored', () => {
    expect(parseLook('trace.timeline')).toEqual({ kind: 'trace', tab: 'schedule' })
    expect(parseLook('trace.schedule')).toBeNull()
  })

  it('knows every Debug section and Trace tab', () => {
    for (const section of ['breakpoints', 'cpu', 'stack', 'memory', 'threads', 'objects']) {
      expect(parseLook(`debug.${section}`)).toEqual({ kind: 'debug', section })
    }
    expect(parseLook('trace.power')).toEqual({ kind: 'trace', tab: 'power' })
  })

  it('reports a target that names no view, and drops it', () => {
    // It would fire and open nothing, with the prose pointing at a view that
    // never appears.
    for (const bad of ['trace.qeues', 'debug.registers', 'dock.gpoi', 'terminal', 'trace', '.queues']) {
      const doc = step(`look: ${bad}`)
      expect(doc.steps[0]!.look).toEqual([])
      expect(doc.problems).toHaveLength(1)
      expect(doc.problems[0]).toContain(`\`look: ${bad}\``)
      expect(doc.problems[0]).toContain('trace.timeline')
    }
    expect(parseLook('debug.constructor')).toBeNull()
  })

  it('keeps the good targets of a list with a bad one in it', () => {
    const doc = step('look:\n  - debug.cpu\n  - debug.cpuu')
    expect(doc.steps[0]!.look).toEqual([{ kind: 'debug', section: 'cpu' }])
    expect(doc.problems[0]).toContain('debug.cpuu')
  })

  it('refuses a block', () => {
    const doc = step('look:\n  trace: queues')
    expect(doc.steps[0]!.look).toEqual([])
    expect(doc.problems[0]).toContain('not a block')
  })

  it('is empty when the step does not ask', () => {
    expect(step('panel: gpio').steps[0]!.look).toEqual([])
  })

  it('takes the instruments as panels', () => {
    for (const kind of ['trace', 'debug', 'perf']) {
      const doc = step(`panel: ${kind}`)
      expect(doc.problems).toEqual([])
      expect(doc.steps[0]!.panel).toBe(kind)
    }
  })

  it('reports a panel kind the dock does not know', () => {
    // Revealing nothing reads exactly like a board without the peripheral.
    const doc = step('panel: gpoi')
    expect(doc.steps[0]!.panel).toBeNull()
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('`panel: gpoi`')
  })

  it('reads and checks `reveal:`, the older spelling of `panel:`', () => {
    expect(step('reveal: led').steps[0]!.panel).toBe('led')
    expect(step('reveal: lde').problems[0]).toContain('`reveal: lde`')
  })
})

describe('directive keys', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('reports a key no directive answers to, and still builds the step', () => {
    const doc = step('wacth:\n  - pin = led as u8\npanel: gpio')
    expect(doc.steps[0]!.panel).toBe('gpio')
    expect(doc.steps[0]!.watch).toEqual([])
    expect(doc.problems).toEqual(['step 1 (“Step”): `wacth:` is not a directive'])
  })

  it('reports it even on a step dropped for having no anchor', () => {
    const doc = parseTour('## Step\n\n```tour\nlok: trace.queues\n```\n\nProse.\n')
    expect(doc.problems.some((p) => p.includes('`lok:`'))).toBe(true)
  })

  it('accepts the reserved keys without a word', () => {
    // Tours written against directives still in review must parse today. None
    // is in review right now; this holds the line for the next one.
    for (const key of RESERVED_KEYS) expect(step(`${key}: anything`).problems).toEqual([])
  })

  it('lists each key once, in one tier only', () => {
    // A later change moves a key from reserved to implemented; leaving a copy
    // behind would make the tiers disagree about what it does.
    const all = [...IMPLEMENTED_KEYS, ...RESERVED_KEYS]
    expect(new Set(all).size).toBe(all.length)
  })

  it('returns the unknown keys in the order written', () => {
    expect(unknownKeys(['at', 'lok', 'await', 'wacth', 'look'])).toEqual(['lok', 'wacth'])
  })
})

describe('objects view', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)
  const queue = 'objects:\n  type: msgq\n  focus: my_msgq'

  it('draws a focused message queue as its ring', () => {
    const doc = step(`${queue}\n  view: ring`)
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: 'my_msgq', view: 'ring' })
  })

  it('draws the ring for a step about one queue without being asked', () => {
    expect(step(queue).steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: 'my_msgq', view: 'ring' })
  })

  it('keeps the plain row with `view: list`', () => {
    const doc = step(`${queue}\n  view: list`)
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: 'my_msgq' })
  })

  it('leaves every other `objects:` as rows', () => {
    expect(step('objects: msgq').steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: null })
    expect(step('objects:\n  type: msgq, sem\n  focus: my_msgq').steps[0]!.objects).toEqual({
      types: ['MSGQ', 'SEM4'],
      focus: 'my_msgq',
    })
  })

  it('reports a ring it could not draw, and a view it does not know', () => {
    // No focus: there is no one queue to draw.
    const unfocused = step('objects:\n  type: msgq\n  view: ring')
    expect(unfocused.steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: null })
    expect(unfocused.problems[0]).toContain('view: ring')
    // A mutex has no ring.
    const mutex = step('objects:\n  type: mutex\n  focus: $arg0\n  view: ring')
    expect(mutex.steps[0]!.objects).toEqual({ types: ['MUTX'], focus: '$arg0' })
    expect(mutex.problems[0]).toContain('type: msgq')
    const typo = step(`${queue}\n  view: rings`)
    expect(typo.steps[0]!.objects).toEqual({ types: ['MSGQ'], focus: 'my_msgq' })
    expect(typo.problems[0]).toContain('`objects: view: rings` is not a view')
  })
})

describe('check, pass, fail and retry', () => {
  const step = (block: string) => parseTour(`## Step\n\n\`\`\`tour\nat: main\n${block}\n\`\`\`\n\nProse.\n`)

  it('takes one comparison or a list, with what to say and whether to retry', () => {
    expect(step('check: alarms_lost as u32 == 1').steps[0]!.check.map((c) => c.text)).toEqual([
      'alarms_lost as u32 == 1',
    ])
    const doc = step(
      [
        'check:',
        '  - alarms_lost as u32 == 1',
        '  - $arg0 == readings',
        'pass: The alarm got through.',
        'fail: Another alarm was lost. Try a different policy.',
        'retry: yes',
      ].join('\n'),
    )
    expect(doc.problems).toEqual([])
    const [only] = doc.steps
    expect(only!.check.map((c) => [c.lhs.expr, c.op, c.rhs.expr])).toEqual([
      ['alarms_lost', '==', '1'],
      ['$arg0', '==', 'readings'],
    ])
    expect(only!.pass).toBe('The alarm got through.')
    expect(only!.fail).toBe('Another alarm was lost. Try a different policy.')
    expect(only!.retry).toBe(true)
  })

  it('checks nothing and moves on by default', () => {
    const [only] = step('panel: gpio').steps
    expect(only!.check).toEqual([])
    expect(only!.pass).toBeNull()
    expect(only!.fail).toBeNull()
    expect(only!.retry).toBe(false)
  })

  it('reports a row that does not parse, and keeps the rows that do', () => {
    const doc = step('check:\n  - alarms_lost as u32 = 1\n  - alarm_in_isr as u32 == 1')
    expect(doc.steps[0]!.check.map((c) => c.text)).toEqual(['alarm_in_isr as u32 == 1'])
    expect(doc.problems).toEqual([
      'step 1 (“Step”): `check: alarms_lost as u32 = 1` compares with `=`; use `==`',
    ])
  })

  it('reads a scalar as one row, so a comma is a mistake rather than two rows', () => {
    const doc = step('check: a as u8 == 1, b as u8 == 2')
    expect(doc.steps[0]!.check).toEqual([])
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('write one per row')
  })

  it('reports an expression or format the guest could never answer', () => {
    expect(step('check: led + == 1').problems[0]).toContain('expression ends early')
    expect(step('check: name as string == 0').problems[0]).toContain('not a number')
    expect(step('check: n as u37 == 0').problems[0]).toContain('`as u37` is not a format')
  })

  it('refuses a block', () => {
    const doc = step('check:\n  used: 8')
    expect(doc.steps[0]!.check).toEqual([])
    expect(doc.problems[0]).toContain('not a block')
  })

  it('reports pass, fail and retry on a step with nothing to check', () => {
    const doc = step('pass: Yes.\nfail: No.\nretry: yes')
    expect(doc.problems).toEqual([
      'step 1 (“Step”): `pass:` needs a `check:` to act on',
      'step 1 (“Step”): `fail:` needs a `check:` to act on',
      'step 1 (“Step”): `retry:` needs a `check:` to act on',
    ])
  })

  it('does not report them again when the check itself is the mistake', () => {
    const doc = step('check: x as u8 = 1\npass: Yes.')
    expect(doc.problems).toHaveLength(1)
    expect(doc.problems[0]).toContain('use `==`')
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

  it('splits a one-line list between entries, never inside a /pattern/', () => {
    // A call with several arguments is the usual thing to point at, and its
    // commas used to split one pattern into two broken entries.
    const one = parseTour(
      '## Step\n\n```tour\nat: main\nhighlight: /K_MSGQ_DEFINE\\(readings, sizeof/ + 1\n```\n\nProse.\n',
    )
    expect(one.problems).toEqual([])
    expect(one.steps[0]!.highlight).toEqual([
      { kind: 'pattern', pattern: 'K_MSGQ_DEFINE\\(readings, sizeof', extra: 1 },
    ])

    const several = parseTour(
      '## Step\n\n```tour\nat: main\nhighlight: /put\\(q, a/, 21-22, /get\\(q, b/ + 2\n```\n\nProse.\n',
    )
    expect(several.problems).toEqual([])
    expect(several.steps[0]!.highlight).toEqual([
      { kind: 'pattern', pattern: 'put\\(q, a', extra: 0 },
      { kind: 'lines', start: 21, end: 22 },
      { kind: 'pattern', pattern: 'get\\(q, b', extra: 2 },
    ])
  })
})

describe('dts', () => {
  it('reads the same highlight spelling against the guest devicetree', () => {
    const doc = parseTour(
      '## Step\n\n```tour\nat: main\ndts: /led0: led_0/ + 3\n```\n\nProse.\n',
    )
    expect(doc.problems).toEqual([])
    expect(doc.steps[0]!.dts).toEqual([
      { kind: 'pattern', pattern: 'led0: led_0', extra: 3 },
    ])
    expect(doc.steps[0]!.highlight).toEqual([])
  })

  it('resolves a pattern to the led0 node', () => {
    const lines = [
      '\tleds {',
      '\t\tcompatible = "gpio-leds";',
      '',
      '\t\tled0: led_0 {',
      '\t\t\tgpios = < &host_gpio 0x4 0x0 >;',
      '\t\t\tlabel = "Host LED0";',
      '\t\t};',
      '\t};',
    ]
    expect(
      resolveHighlightSpecs([{ kind: 'pattern', pattern: 'led0: led_0', extra: 3 }], lines),
    ).toEqual([{ start: 4, end: 7 }])
  })

  it('finds led0 in the packaged blinky trees', () => {
    const spec = [{ kind: 'pattern' as const, pattern: 'led0: led_0', extra: 3 }]
    for (const src of [m3Blinky, a53Blinky]) {
      const ranges = resolveHighlightSpecs(spec, src.split('\n'))
      expect(ranges).toHaveLength(1)
      const excerpt = src.split('\n').slice(ranges[0]!.start - 1, ranges[0]!.end)
      expect(excerpt.join('\n')).toContain('gpios')
    }
  })

  it('finds button0 in the packaged blinky trees', () => {
    const spec = [{ kind: 'pattern' as const, pattern: 'button0: button_0', extra: 4 }]
    for (const src of [m3Blinky, a53Blinky]) {
      const ranges = resolveHighlightSpecs(spec, src.split('\n'))
      expect(ranges).toHaveLength(1)
      const excerpt = src.split('\n').slice(ranges[0]!.start - 1, ranges[0]!.end)
      expect(excerpt.join('\n')).toContain('gpios')
    }
  })
})

describe('sources', () => {
  const tour = (front: string) =>
    parseTour(
      [
        '---',
        'tour: Kernel stops',
        'sample: samples/kernel/msg_queue',
        front,
        '---',
        '',
        '## Step',
        '',
        '```tour',
        'at: z_impl_k_msgq_put',
        '```',
        '',
        'Prose.',
        '',
      ].join('\n'),
    )

  it('reads the Zephyr files a tour wants shipped, as a list or on one line', () => {
    const listed = tour('sources:\n  - kernel/msg_q.c\n  - zephyr-module/drivers/qemu_host_gpio.c')
    expect(listed.sources).toEqual(['kernel/msg_q.c', 'zephyr-module/drivers/qemu_host_gpio.c'])
    expect(listed.problems).toEqual([])
    expect(tour('sources: kernel/msg_q.c, kernel/sched.c').sources).toEqual([
      'kernel/msg_q.c',
      'kernel/sched.c',
    ])
  })

  it('is empty when the tour asks for nothing beyond the sample', () => {
    expect(tour('').sources).toEqual([])
    expect(parseTour(TOUR).sources).toEqual([])
  })

  it('refuses a path that would reach outside the Zephyr tree, and says so', () => {
    const doc = tour('sources:\n  - /etc/passwd\n  - ../outside.c\n  - kernel/../../x.c\n  - kernel/msg_q.c')
    expect(doc.sources).toEqual(['kernel/msg_q.c'])
    expect(doc.problems).toHaveLength(3)
    expect(doc.problems[0]).toContain('`sources: /etc/passwd`')
    expect(doc.problems[1]).toContain('`sources: ../outside.c`')
    expect(doc.problems[2]).toContain('`sources: kernel/../../x.c`')
  })
})
