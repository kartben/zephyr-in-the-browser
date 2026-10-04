import { describe, expect, it } from 'vitest'
import { ROW_IS_STMT, ROW_PROLOGUE_END, type LineIndex } from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import { checkTour, formatReport, reportRows, type CheckContext } from '@/tours/check'
import { parseTour, type TourDoc } from '@/tours/parse'

/*
 * A sample in miniature, as an image would ship it: its main.c, a line table
 * for it, the symbols, and a devicetree. `helper()` is inlined into both
 * `main()` and `worker()`, line 14 is a `LOG_INF()` whose expansion starts
 * three statements around a header's lines, and two functions are called
 * `handler`, as statics in different files can be.
 */

const SOURCE = [
  '#include <zephyr/kernel.h>', //  1
  '#include <zephyr/logging/log.h>', //  2
  '', //  3
  'static int counter;', //  4
  '', //  5
  'static inline int helper(int x)', //  6
  '{', //  7
  '\treturn x * 2;', //  8
  '}', //  9
  '', // 10
  'int main(void)', // 11
  '{', // 12
  '\tgpio_toggle();', // 13
  '\tLOG_INF("hello");', // 14
  '\tcounter = helper(1);', // 15
  '\treturn 0;', // 16
  '}', // 17
  '', // 18
  'void worker(void)', // 19
  '{', // 20
  '\tcounter = helper(2);', // 21
  '}', // 22
  '',
].join('\n')

function lines(): LineIndex {
  const MAIN = 0
  const LOG_H = 1
  const rows = [
    // main()
    { addr: 0x8000, file: MAIN, line: 12, flags: ROW_IS_STMT },
    { addr: 0x8004, file: MAIN, line: 13, flags: ROW_IS_STMT | ROW_PROLOGUE_END },
    { addr: 0x8008, file: MAIN, line: 14, flags: ROW_IS_STMT },
    { addr: 0x800c, file: LOG_H, line: 100, flags: ROW_IS_STMT },
    { addr: 0x8010, file: MAIN, line: 14, flags: ROW_IS_STMT },
    { addr: 0x8014, file: LOG_H, line: 101, flags: ROW_IS_STMT },
    { addr: 0x8018, file: MAIN, line: 14, flags: ROW_IS_STMT },
    { addr: 0x801c, file: MAIN, line: 15, flags: ROW_IS_STMT },
    { addr: 0x8020, file: MAIN, line: 8, flags: ROW_IS_STMT },
    { addr: 0x8024, file: MAIN, line: 16, flags: ROW_IS_STMT },
    { addr: 0x8028, file: MAIN, line: 17, flags: 0 },
    // worker()
    { addr: 0x9000, file: MAIN, line: 20, flags: ROW_IS_STMT },
    { addr: 0x9004, file: MAIN, line: 21, flags: ROW_IS_STMT | ROW_PROLOGUE_END },
    { addr: 0x9008, file: MAIN, line: 8, flags: ROW_IS_STMT },
    { addr: 0x900c, file: MAIN, line: 22, flags: ROW_IS_STMT },
  ]
  return {
    addrs: new Float64Array(rows.map((r) => r.addr)),
    lines: new Int32Array(rows.map((r) => r.line)),
    fileIds: new Int32Array(rows.map((r) => r.file)),
    flags: new Uint8Array(rows.map((r) => r.flags)),
    files: ['/zephyr/samples/app/src/main.c', '/zephyr/include/zephyr/logging/log.h'],
    baseNames: ['main.c', 'log.h'],
  }
}

const FUNCTIONS = [
  { name: 'main', addr: 0x8000, size: 0x40 },
  { name: 'worker', addr: 0x9000, size: 0x20 },
  { name: 'handler', addr: 0xa000, size: 0x10 },
  { name: 'handler', addr: 0xa100, size: 0x10 },
]

const symbols: SymbolIndex = {
  byAddr: FUNCTIONS,
  byName: [...FUNCTIONS].sort((a, b) => a.name.localeCompare(b.name) || a.addr - b.addr),
  objects: new Map([['counter', { name: 'counter', addr: 0x2000, size: 4 }]]),
}

const DTS = ['/ {', '\tleds {', '\t\tled0: led_0 {', '\t\t\tgpios = <&gpio0 2 0>;', '\t\t};', '\t};', '};', '']

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    symbols,
    lines: lines(),
    arch: 'aarch64',
    sources: new Map([['main.c', SOURCE.split('\n')]]),
    dts: { name: 'app.dts', lines: DTS },
    strict: false,
    ...overrides,
  }
}

/** A tour with one step per directive block, each with a line of prose. */
function tour(...blocks: string[]): TourDoc {
  const text = [
    '---',
    'tour: Fixture',
    'sample: samples/app',
    '---',
    '',
    ...blocks.flatMap((block, i) => [`## Step ${i + 1}`, '', '```tour', block.trim(), '```', '', 'Prose.', '']),
  ].join('\n')
  const doc = parseTour(text)
  expect(doc.problems).toEqual([])
  return doc
}

describe('checkTour', () => {
  it('passes a tour whose every anchor lands where it says', () => {
    const doc = tour(
      'at: main.c:/gpio_toggle/ | main.c:13',
      'at: main\nhighlight: /gpio_toggle/',
      [
        'at: worker',
        'highlight: /helper\\(2\\)/',
        'watch:',
        '  - counter as u32',
        '  - entry = $arg0 as dec',
        '  - stopped in = main as code',
      ].join('\n'),
      'at: main.c:13\ndts: /led0: led_0/ + 1',
    )
    expect(checkTour(doc, context())).toEqual([])
  })

  it('fails an anchor that resolves nowhere, with every reason', () => {
    const [finding, ...rest] = checkTour(tour('at: nope | main.c:99'), context())
    expect(rest).toEqual([])
    expect(finding).toMatchObject({ step: 1, severity: 'fail', kind: 'unresolved' })
    expect(finding!.message).toContain('`nope`: no such function')
    expect(finding!.message).toContain('`main.c:99`: no code at or after that line')
  })

  it('fails on drift: the pattern stopped matching and the line number took over', () => {
    expect(checkTour(tour('at: main.c:/gpio_toggle_dt/ | main.c:13'), context())).toEqual([
      {
        step: 1,
        severity: 'fail',
        kind: 'drift',
        message:
          '`main.c:/gpio_toggle_dt/`: no line matches, so the page falls back to `main.c:13` ' +
          'and stops on main.c:13 in main, which may no longer be the right line: fix the pattern',
      },
    ])
    // A pattern anywhere before the winner counts, and so does one naming a
    // file the image does not ship among its sources.
    const doc = tour('at: helper_fn | main.c:/gpio_toggle_dt/ | main.c:13', 'at: other.c:/x/ | main.c:13')
    expect(checkTour(doc, context()).map((f) => [f.step, f.kind])).toEqual([
      [1, 'drift'],
      [2, 'drift'],
    ])
  })

  it('takes a missing function as a per-board spelling, not as drift', () => {
    expect(checkTour(tour('at: qhg_pin_configure | main'), context())).toEqual([])
  })

  it('counts what an image without sources cannot check, and fails it only when strict', () => {
    const doc = tour('at: main.c:/gpio_toggle/ | main.c:13', 'at: main\nhighlight: /gpio_toggle/')
    const unchecked = {
      step: null,
      kind: 'unchecked',
      message: expect.stringContaining('ships no sources for this sample, so 2 steps'),
    }
    expect(checkTour(doc, context({ sources: null }))).toEqual([{ ...unchecked, severity: 'warn' }])
    expect(checkTour(doc, context({ sources: null, strict: true }))).toEqual([{ ...unchecked, severity: 'fail' }])
  })

  it('warns when the line-number fallback no longer lands where its pattern does', () => {
    const doc = tour('at: main.c:/gpio_toggle/ | main.c:12', 'at: main.c:/gpio_toggle/ | main.c:99 | main')
    expect(checkTour(doc, context())).toEqual([
      {
        step: 1,
        severity: 'warn',
        kind: 'stale-line',
        message:
          'the fallback `main.c:12` stops on main.c:12 in main, but `main.c:/gpio_toggle/` stops on ' +
          'main.c:13 in main: update the line number',
      },
      {
        step: 2,
        severity: 'warn',
        kind: 'stale-line',
        message: expect.stringContaining('the fallback `main.c:99` resolves nowhere'),
      },
    ])
  })

  it('warns when the landed line starts statements in more than one place', () => {
    const doc = tour('at: main.c:/LOG_INF/ | main.c:14', 'at: main.c:/return x \\* 2/ | main.c:8')
    expect(checkTour(doc, context())).toEqual([
      {
        step: 1,
        severity: 'warn',
        kind: 'multi-address',
        message:
          'main.c:14 starts statements at 3 addresses in main, and the step only stops at the first: ' +
          'a `LOG_*()` line, a loop header or code inlined twice does this',
      },
      {
        step: 2,
        severity: 'warn',
        kind: 'multi-address',
        message:
          'main.c:8 has code in 2 functions (main, worker), and the step only stops in main: ' +
          'inlined code does this',
      },
    ])
  })

  it('warns when more than one function has the anchor’s name', () => {
    expect(checkTour(tour('at: handler'), context())).toEqual([
      {
        step: 1,
        severity: 'warn',
        kind: 'ambiguous',
        message: '2 functions are named `handler`, and the step stops in the one at 0xa000',
      },
    ])
  })

  it('fails a highlight that marks nothing in the file the step stops in', () => {
    const doc = tour(
      'at: main\nhighlight:\n  - /gpio_toggle/ + 2\n  - /gpio_toggle_dt/\n  - 99',
      // 0x800c is inside the LOG_INF expansion, on a line of log.h.
      'at: 0x800c\nhighlight: /LOG/',
    )
    expect(checkTour(doc, context()).map((f) => [f.step, f.severity, f.kind, f.message])).toEqual([
      [1, 'fail', 'highlight', '`highlight: /gpio_toggle_dt/` matches nothing in main.c'],
      [1, 'fail', 'highlight', '`highlight: 99` starts past the end of main.c (22 lines)'],
      [2, 'fail', 'highlight', 'the step stops in log.h, which the image does not ship, so `highlight:` cannot show'],
    ])
  })

  it('fails an expression naming a symbol the ELF lacks, and lets registers through', () => {
    const doc = tour(
      [
        'at: main',
        'watch:',
        '  - $arg0 as dec',
        '  - *$sp as ptr',
        '  - counter + 1p as u8',
        '  - missing as u32',
        'memory:',
        '  at: nothing_here',
        '  len: 8',
        '  mark: 0..1p',
        'objects:',
        '  type: mutex',
        '  focus: $arg0 + absent',
      ].join('\n'),
    )
    expect(checkTour(doc, context()).map((f) => [f.kind, f.message])).toEqual([
      ['symbol', '`watch: missing`: no symbol `missing` in this build'],
      ['symbol', '`memory: at: nothing_here`: no symbol `nothing_here` in this build'],
      ['symbol', '`objects: focus: $arg0 + absent`: no symbol `absent` in this build'],
    ])
  })

  it('fails a check naming a symbol the ELF lacks, since it could never pass', () => {
    const doc = tour(
      [
        'at: main',
        'check:',
        '  - counter as u32 == 1',
        '  - $arg0 == missing',
        '  - absent as u8 >= absent + 1',
        'pass: Yes.',
      ].join('\n'),
    )
    expect(checkTour(doc, context()).map((f) => [f.kind, f.message])).toEqual([
      ['symbol', '`check: $arg0 == missing`: no symbol `missing` in this build'],
      ['symbol', '`check: absent as u8 >= absent + 1`: no symbol `absent` in this build'],
    ])
  })

  it('holds a `when:` predicate to the same, since the page skips a step it can never fire', () => {
    const member = (struct: string, name: string) => (struct === 'k_msgq' && name === 'used_msgs' ? 0x20 : null)
    const doc = tour(
      [
        'at: main',
        'when:',
        '  - $arg0 == counter',
        '  - missing as u32 == 1',
        '  - k_msgq(counter).nope as u32 == 0',
        '  - hits == 2',
      ].join('\n'),
    )
    expect(checkTour(doc, context({ member })).map((f) => [f.kind, f.message])).toEqual([
      ['symbol', '`when: missing as u32 == 1`: no symbol `missing` in this build'],
      ['member', '`when: k_msgq(counter).nope as u32 == 0`: `struct k_msgq` has no member `nope` in this build'],
    ])
  })

  it('fails a member view the image’s DWARF does not describe, and takes no struct for a symbol', () => {
    const member = (struct: string, name: string) =>
      struct === 'k_msgq' ? ({ wait_q: 0, used_msgs: 0x20 } as Record<string, number>)[name] ?? null : null
    const doc = tour(
      [
        'at: main',
        'watch:',
        '  - k_msgq(counter).used as u32',
        '  - k_mutex($arg0).owner as ptr',
        'check: k_msgq(counter).used_msgs as u32 >= k_msgq(counter).max_msgs as u32',
      ].join('\n'),
    )
    expect(checkTour(doc, context({ member })).map((f) => [f.kind, f.message])).toEqual([
      ['member', '`watch: k_msgq(counter).used`: `struct k_msgq` has no member `used` in this build'],
      ['member', '`watch: k_mutex($arg0).owner`: `struct k_mutex` has no member `owner` in this build'],
      [
        'member',
        '`check: k_msgq(counter).used_msgs as u32 >= k_msgq(counter).max_msgs as u32`: ' +
          '`struct k_msgq` has no member `max_msgs` in this build',
      ],
    ])
    // With no DWARF to ask, member views go unchecked rather than failing.
    expect(checkTour(doc, context())).toEqual([])
  })

  it('fails an expression that does not parse', () => {
    expect(checkTour(tour('at: main\nwatch:\n  - counter & 3 as u32'), context())).toEqual([
      { step: 1, severity: 'fail', kind: 'expression', message: '`watch: counter & 3` is not an expression' },
    ])
    expect(checkTour(tour('at: main\nwatch:\n  - counter + as u32'), context())).toEqual([
      { step: 1, severity: 'fail', kind: 'expression', message: '`watch: counter +` is not an expression' },
    ])
  })

  it('warns when no `dts:` entry matches the board, and takes one spelling per board', () => {
    expect(checkTour(tour('at: main\ndts: /button0: button_0/'), context())).toEqual([
      {
        step: 1,
        severity: 'warn',
        kind: 'dts',
        message: 'no `dts:` entry (`/button0: button_0/`) matches app.dts, so the card shows no devicetree on this board',
      },
    ])
    const spellings = tour('at: main\ndts:\n  - /button0: button_0/\n  - /led0: led_0/ + 1')
    expect(checkTour(spellings, context())).toEqual([])
    expect(checkTour(spellings, context({ dts: null }))).toEqual([
      {
        step: null,
        severity: 'warn',
        kind: 'unchecked',
        message: 'the image ships no devicetree, so 1 step with `dts:` went unchecked',
      },
    ])
  })
})

describe('the report', () => {
  it('has one row per finding, and one `ok` row for an image with none', () => {
    const rows = [
      ...reportRows({ tour: 'blinky', board: 'qemu_cortex_m3', image: 'blinky.elf' }, [], 3),
      ...reportRows({ tour: 'philosophers', board: 'qemu_riscv32', image: 'philosophers.elf' }, [
        { step: null, severity: 'warn', kind: 'unchecked', message: 'no sources' },
        { step: 2, severity: 'fail', kind: 'drift', message: 'the pattern moved' },
      ], 6),
    ]
    const table = formatReport(rows).split('\n')
    expect(table.map((line) => line.split(/ {2,}/))).toEqual([
      ['tour', 'board', 'image', 'step', 'status', 'detail'],
      ['blinky', 'qemu_cortex_m3', 'blinky.elf', '-', 'ok', '3 steps'],
      ['philosophers', 'qemu_riscv32', 'philosophers.elf', '-', 'warn unchecked', 'no sources'],
      ['philosophers', 'qemu_riscv32', 'philosophers.elf', '2', 'FAIL drift', 'the pattern moved'],
    ])
    // Aligned: every row's detail starts in the same column.
    const column = table[0]!.indexOf('detail')
    expect(table.map((line) => line.slice(column))).toEqual(['detail', '3 steps', 'no sources', 'the pattern moved'])
  })
})
