import { describe, expect, it } from 'vitest'
import type { LineIndex } from '@/debug/dwarfLines'
import { ROW_IS_STMT, ROW_PROLOGUE_END } from '@/debug/dwarfLines'
import type { SymbolIndex } from '@/debug/elfSymbols'
import { patternFile, resolveAnchor } from '@/tours/anchors'

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
