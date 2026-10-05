import { describe, expect, it } from 'vitest'
import { hoverExpression } from '@/debug/dwarf/hoverExpr'

/** The expression a hover on the first occurrence of `at` (offset `k` in it) asks about. */
function hover(line: string, at: string, k = 0): string | null {
  const column = line.indexOf(at)
  if (column < 0) throw new Error(`${at} not in ${line}`)
  return hoverExpression(line, column + k)?.text ?? null
}

describe('hoverExpression (VS Code rule)', () => {
  const line = '\tif (evt->sync == 0) {'

  it('takes a name on its own', () => {
    expect(hover(line, 'evt')).toBe('evt')
    expect(hover(line, 'evt', 2)).toBe('evt')
  })

  it('keeps a member chain up to the hovered member', () => {
    expect(hover(line, 'sync')).toBe('evt->sync')
    expect(hover('\tled_set_brightness_dt(&led0, evt->value ? 100 : 0);', 'value')).toBe('evt->value')
    expect(hover('a.b.c.d', 'b')).toBe('a.b')
    expect(hover('a.b.c.d', 'd')).toBe('a.b.c.d')
  })

  it('cuts at the word under the pointer, not the end of the chain', () => {
    expect(hover('x = dev->config->port;', 'dev')).toBe('dev')
    expect(hover('x = dev->config->port;', 'config')).toBe('dev->config')
  })

  it('stops at brackets and operators', () => {
    expect(hover('printk("%d", evt->code);', 'printk')).toBe('printk')
    expect(hover('a + b', 'b')).toBe('b')
    expect(hover('buf[i] = 0;', 'i')).toBe('i')
    expect(hover('buf[i] = 0;', 'buf')).toBe('buf')
  })

  it('keeps unary operators the way VS Code does', () => {
    expect(hover('\tled_set_brightness_dt(&led0, 1);', 'led0')).toBe('&led0')
    expect(hover('return *ptr;', 'ptr')).toBe('*ptr')
  })

  it('gives nothing on whitespace or an operator', () => {
    expect(hoverExpression(line, 0)).toBeNull()
    expect(hover(line, '==')).toBeNull()
  })

  it('reports the columns it covers', () => {
    const at = line.indexOf('sync')
    expect(hoverExpression(line, at)).toEqual({ text: 'evt->sync', start: line.indexOf('evt'), end: at + 4 })
  })
})
