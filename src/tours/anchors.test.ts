import { describe, expect, it } from 'vitest'
import type { LineIndex } from '@/debug/dwarfLines'
import { ROW_IS_STMT, ROW_PROLOGUE_END } from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import { patternFile, resolveAnchor, resolveShow } from '@/tours/anchors'

/** Two functions and four rows of main.c, hand-built. */
function lines(): LineIndex {
  const rows = [
    { addr: 0x8000, line: 23, flags: ROW_IS_STMT },
    { addr: 0x8004, line: 28, flags: ROW_IS_STMT | ROW_PROLOGUE_END },
    { addr: 0x8010, line: 32, flags: ROW_IS_STMT },
    { addr: 0x8020, line: 38, flags: ROW_IS_STMT },
  ]
  return {
    addrs: new Float64Array(rows.map((r) => r.addr)),
    lines: new Int32Array(rows.map((r) => r.line)),
    fileIds: new Int32Array(rows.map(() => 0)),
    flags: new Uint8Array(rows.map((r) => r.flags)),
    files: ['/home/build/zephyr/samples/basic/blinky/src/main.c'],
    baseNames: ['main.c'],
  }
}

const symbols: SymbolIndex = {
  byAddr: [{ name: 'main', addr: 0x8000, size: 0x40 }],
  byName: [{ name: 'main', addr: 0x8000, size: 0x40 }],
  objects: new Map([['led', { name: 'led', addr: 0x2000, size: 8 }]]),
}

const context = { symbols, lines: lines(), arch: 'aarch64' as const }

describe('resolveAnchor', () => {
  it('resolves a line through the line table, reporting where it landed', () => {
    const result = resolveAnchor('main.c:32', context)
    expect(result).toEqual({
      ok: true,
      anchor: {
        addr: 0x8010,
        via: 'line',
        file: '/home/build/zephyr/samples/basic/blinky/src/main.c',
        line: 32,
        symbol: 'main',
      },
    })
  })

  it('resolves a bare function past its prologue', () => {
    const result = resolveAnchor('main', context)
    expect(result).toMatchObject({ ok: true, anchor: { addr: 0x8004, via: 'symbol', line: 28 } })
  })

  it('takes an offset from a function, verbatim', () => {
    expect(resolveAnchor('main + 0x10', context)).toMatchObject({
      ok: true,
      anchor: { addr: 0x8010, via: 'symbol', symbol: 'main' },
    })
  })

  it('takes a raw address', () => {
    expect(resolveAnchor('0x8020', context)).toMatchObject({
      ok: true,
      anchor: { addr: 0x8020, via: 'address', line: 38 },
    })
  })

  it('finds the first line matching a pattern', () => {
    const sources = new Map([['main.c', ['/* 1 */', 'int main(void)', '{', '\tgpio_toggle();']]])
    // The pattern is on line 4; the nearest row at or after it is line 23.
    expect(resolveAnchor('main.c:/gpio_toggle/', { ...context, sources })).toMatchObject({
      ok: true,
      anchor: { via: 'pattern', addr: 0x8000, line: 23 },
    })
  })

  it('explains itself when it cannot resolve', () => {
    expect(resolveAnchor('nope', context)).toEqual({
      ok: false,
      error: '`nope`: no such function in this build',
    })
    expect(resolveAnchor('main.c:999', context)).toMatchObject({ ok: false })
    expect(resolveAnchor('main.c:/absent/', { ...context, sources: new Map([['main.c', ['x']]]) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('no line matches') })
    expect(resolveAnchor('main.c:/x/', context)).toMatchObject({
      ok: false,
      error: expect.stringContaining('was not shipped'),
    })
    expect(resolveAnchor('main.c:12', { ...context, lines: null })).toMatchObject({ ok: false })
  })

  it('drops the Thumb bit on Cortex-M, where symbols carry it', () => {
    const thumb: SymbolIndex = {
      byAddr: [{ name: 'main', addr: 0x8001, size: 0x40 }],
      byName: [{ name: 'main', addr: 0x8001, size: 0x40 }],
      objects: new Map(),
    }
    expect(resolveAnchor('main', { symbols: thumb, lines: null, arch: 'arm' })).toMatchObject({
      ok: true,
      anchor: { addr: 0x8000 },
    })
  })
})

describe('patternFile', () => {
  it('names the file a pattern anchor needs the text of', () => {
    expect(patternFile('main.c:/toggle/')).toBe('main.c')
    expect(patternFile('main.c:32')).toBeNull()
    expect(patternFile('main')).toBeNull()
  })
})

describe('fallback chains', () => {
  it('takes the first alternative that resolves', () => {
    const sources = new Map([['main.c', ['int main(void)', '{', '\tgpio_toggle();']]])
    // Pattern wins when the sources are there…
    expect(resolveAnchor('main.c:/gpio_toggle/ | main.c:38', { ...context, sources })).toMatchObject(
      { ok: true, anchor: { via: 'pattern' } },
    )
    // …and the line number carries it when they are not, which is what an
    // image tarball older than the tour looks like.
    expect(resolveAnchor('main.c:/gpio_toggle/ | main.c:32', context)).toMatchObject({
      ok: true,
      anchor: { via: 'line', line: 32 },
    })
  })

  it('reports every reason when no alternative resolves', () => {
    const result = resolveAnchor('main.c:/x/ | nope', context)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('was not shipped')
      expect(result.error).toContain('no such function')
    }
  })
})

/* ------------------------------------------------------------------ *
 * show: — what the reader looks at, which is not where the machine stopped
 * ------------------------------------------------------------------ */

const source = [
  '#include <zephyr/kernel.h>', // 1
  '', // 2
  '#define SLEEP_TIME_MS 1000', // 3
  '', // 4
  '#define LED0_NODE DT_ALIAS(led0)', // 5
  '', // 6
  'static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(LED0_NODE, gpios);', // 7
  '', // 8
  'int main(void)', // 9
  '{', // 10
  '\tk_msleep(SLEEP_TIME_MS);', // 11
  '}', // 12
]

const sources = new Map([['main.c', source]])

/** An anchor that landed on main.c:9, as `at: main` would. */
const landed = { addr: 0x8000, via: 'symbol' as const, file: 'src/main.c', line: 9, symbol: 'main' }

describe('resolveShow', () => {
  it('marks a range between two patterns, in the file the anchor landed in', () => {
    const show = resolveShow({ file: null, mark: { start: '/LED0_NODE/', end: '/GPIO_DT_SPEC_GET/' }, note: 'why' }, landed, sources)
    // Starts at the #define, not at the second mention on line 7.
    expect(show).toEqual({ file: 'main.c', start: 5, end: 7, note: 'why' })
  })

  it('excerpts a different file from the one the breakpoint is in', () => {
    // The blinky k_msleep step: stopped in the kernel, pointing at the sample.
    const inKernel = { addr: 0x100, via: 'symbol' as const, file: 'kernel/sched.c', line: 900, symbol: 'z_impl_k_sleep' }
    const show = resolveShow({ file: 'main.c', mark: { start: '/k_msleep/', end: '/k_msleep/' }, note: null }, inKernel, sources)
    expect(show).toEqual({ file: 'main.c', start: 11, end: 11, note: null })
  })

  it('searches for the end pattern forward from the start, not from the top', () => {
    // SLEEP_TIME_MS is on line 3 as well as line 11. Searching from the top
    // would find the #define, above the start, and give an inverted range.
    const show = resolveShow({ file: null, mark: { start: '/int main/', end: '/SLEEP_TIME_MS/' }, note: null }, landed, sources)
    expect(show).toEqual({ file: 'main.c', start: 9, end: 11, note: null })
  })

  it('takes plain line numbers, which need no source text at all', () => {
    const show = resolveShow({ file: 'main.c', mark: { start: '3', end: '5' }, note: null }, null, new Map())
    expect(show).toEqual({ file: 'main.c', start: 3, end: 5, note: null })
  })

  it('falls back to the anchor line when the block only renames the file', () => {
    const show = resolveShow({ file: 'other.c', mark: null, note: null }, landed, sources)
    expect(show).toEqual({ file: 'other.c', start: 9, end: 9, note: null })
  })

  it('is nothing to show, rather than an error, when a pattern misses', () => {
    expect(resolveShow({ file: null, mark: { start: '/nope/', end: '/nope/' }, note: null }, landed, sources)).toBeNull()
  })

  it('is nothing to show when the file was never shipped', () => {
    expect(resolveShow({ file: 'absent.c', mark: { start: '/main/', end: '/main/' }, note: null }, landed, sources)).toBeNull()
  })

  it('never returns an inverted range', () => {
    const show = resolveShow({ file: null, mark: { start: '10', end: '2' }, note: null }, landed, sources)
    expect(show).toEqual({ file: 'main.c', start: 10, end: 10, note: null })
  })
})
