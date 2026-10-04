import { describe, expect, it } from 'vitest'
import type { LineIndex } from '@/debug/dwarfLines'
import { ROW_IS_STMT, ROW_PROLOGUE_END } from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import { anchorAlternatives, patternFile, resolveAnchor, sourceSpelling } from '@/tours/anchors'

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

  it('searches only a named function for a scoped pattern', () => {
    // The same line in two functions: a() on lines 22-26, b() on lines 30-36.
    const text = Array.from({ length: 40 }, () => '')
    text[21] = 'static void a(void)'
    text[22] = '{'
    text[24] = '\tBUS_UNLOCK();'
    text[25] = '}'
    text[29] = 'static void b(void)'
    text[30] = '{'
    text[34] = '\tBUS_UNLOCK();'
    text[35] = '}'
    const ctx = { ...context, sources: new Map([['main.c', text]]) }
    // Line 25 is a()'s; the nearest row at or after it is line 28.
    expect(resolveAnchor('main.c:/BUS_UNLOCK/', ctx)).toMatchObject({
      ok: true,
      anchor: { via: 'pattern', addr: 0x8004, line: 28 },
    })
    // Line 35 is b()'s; the nearest row at or after it is line 38.
    expect(resolveAnchor('main.c:b/BUS_UNLOCK/', ctx)).toMatchObject({
      ok: true,
      anchor: { via: 'pattern', addr: 0x8020, line: 38 },
    })
    expect(resolveAnchor('main.c:c/BUS_UNLOCK/', ctx)).toEqual({
      ok: false,
      error: '`main.c:c/BUS_UNLOCK/`: `main.c` defines no `c()`',
    })
    expect(resolveAnchor('main.c:a/nothing/', ctx)).toEqual({
      ok: false,
      error: '`main.c:a/nothing/`: no line in `a()` matches',
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

  it('names the nearest enclosing function, not the first whose size reaches', () => {
    // The ESP32-C3 ROM's memset keeps picolibc's size in a jump table of
    // 4-byte slots, so its range runs over memcpy.
    const memset = { name: 'memset', addr: 0x40000354, size: 220 }
    const memcpy = { name: 'memcpy', addr: 0x40000358, size: 412 }
    const rom: SymbolIndex = { byAddr: [memset, memcpy], byName: [memcpy, memset], objects: new Map() }
    const ctx = { symbols: rom, lines: null, arch: 'riscv32' as const }
    expect(resolveAnchor('0x40000358', ctx)).toMatchObject({ ok: true, anchor: { symbol: 'memcpy' } })
    expect(resolveAnchor('0x40000354', ctx)).toMatchObject({ ok: true, anchor: { symbol: 'memset' } })
  })

  it('measures Thumb functions from their start, not from their odd value', () => {
    // Picolibc's absolute vfscanf is 0 plus the Thumb bit, and its 3640 bytes
    // reach over main, which starts at 0xb4c.
    const vfscanf = { name: 'vfscanf', addr: 0x1, size: 3640 }
    const main = { name: 'main', addr: 0xb4d, size: 116 }
    const thumb: SymbolIndex = { byAddr: [vfscanf, main], byName: [main, vfscanf], objects: new Map() }
    expect(resolveAnchor('0xb4c', { symbols: thumb, lines: null, arch: 'arm' })).toMatchObject({
      ok: true,
      anchor: { symbol: 'main' },
    })
  })
})

describe('patternFile', () => {
  it('treats a scoped pattern as a pattern', () => {
    expect(patternFile('main.c:storage_entry/BUS_UNLOCK/ | main.c:283')).toBe('main.c')
    expect(sourceSpelling('main.c:storage_entry/BUS_UNLOCK/')).toEqual({ kind: 'pattern', file: 'main.c' })
  })

  it('names the file a pattern anchor needs the text of', () => {
    expect(patternFile('main.c:/toggle/')).toBe('main.c')
    expect(patternFile('main.c:32')).toBeNull()
    expect(patternFile('main')).toBeNull()
  })
})

describe('anchorAlternatives and sourceSpelling', () => {
  it('splits an `at:` the way it is tried', () => {
    expect(anchorAlternatives(' main.c:/toggle/ | main.c:38 |  ')).toEqual(['main.c:/toggle/', 'main.c:38'])
  })

  it('says how an alternative names a source file, when it does', () => {
    expect(sourceSpelling('main.c:/toggle/')).toEqual({ kind: 'pattern', file: 'main.c' })
    expect(sourceSpelling(' Main.c:38 ')).toEqual({ kind: 'line', file: 'main.c' })
    expect(sourceSpelling('main')).toBeNull()
    expect(sourceSpelling('0x8000')).toBeNull()
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
