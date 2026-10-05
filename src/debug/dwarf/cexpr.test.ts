import { describe, expect, it } from 'vitest'
import { parseExpression } from '@/debug/dwarf/cexpr'

describe('parseExpression', () => {
  it('parses names and member chains', () => {
    expect(parseExpression('evt')).toEqual({ op: 'name', name: 'evt' })
    expect(parseExpression('evt->code')).toEqual({
      op: 'member',
      base: { op: 'name', name: 'evt' },
      name: 'code',
      arrow: true,
    })
    expect(parseExpression('led0.dev')).toEqual({
      op: 'member',
      base: { op: 'name', name: 'led0' },
      name: 'dev',
      arrow: false,
    })
  })

  it('parses indexing, dereference and address-of', () => {
    expect(parseExpression('buf[3]')).toEqual({
      op: 'index',
      base: { op: 'name', name: 'buf' },
      index: { op: 'num', value: 3n },
    })
    expect(parseExpression('*p')).toEqual({ op: 'deref', base: { op: 'name', name: 'p' } })
    expect(parseExpression('&led0')).toEqual({ op: 'addr', base: { op: 'name', name: 'led0' } })
    expect(parseExpression('(*evt).dev')).toEqual({
      op: 'member',
      base: { op: 'deref', base: { op: 'name', name: 'evt' } },
      name: 'dev',
      arrow: false,
    })
    expect(parseExpression('a[0x10]')?.op).toBe('index')
  })

  it('refuses what a hover never produces', () => {
    expect(parseExpression('')).toBeNull()
    expect(parseExpression('a + b')).toBeNull()
    expect(parseExpression('f(x)')).toBeNull()
    expect(parseExpression('.code')).toBeNull()
    expect(parseExpression('evt->')).toBeNull()
    expect(parseExpression('"text"')).toBeNull()
  })
})
