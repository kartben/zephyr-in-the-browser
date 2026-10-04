import { describe, expect, it } from 'vitest'
import type { TourTarget } from '@/tours/expr'
import {
  COMPARE_OPS,
  evalPredicate,
  parsePredicate,
  predicateIdentifiers,
  type PredicateSpec,
} from '@/tours/predicate'

/**
 * A pretend guest at the moment the lost-alarm step fires: two counters, a
 * flag, a queue whose first field points at its ring buffer, and `$arg0`
 * holding the queue's address the way it would on entry to `k_msgq_put()`.
 */
function target(pointerBytes: 4 | 8 = 4): TourTarget & { reads: number } {
  const memory = new Map<number, number>()
  const put = (addr: number, bytes: number[]) => bytes.forEach((b, i) => memory.set(addr + i, b))
  const word = (value: number) =>
    Array.from({ length: pointerBytes }, (_, i) => Math.floor(value / 2 ** (i * 8)) & 0xff)

  const symbols: Record<string, number> = {
    alarms_lost: 0x1000,
    alarm_in_isr: 0x1004,
    ticks: 0x1008,
    drop_oldest: 0x100c,
    readings: 0x2000,
    ring: 0x2100,
  }
  put(0x1000, [2, 0, 0, 0]) // alarms_lost
  put(0x1004, [1, 0, 0, 0]) // alarm_in_isr
  put(0x1008, [0xff, 0xff, 0xff, 0xff]) // ticks, gone to -1
  put(0x100c, [1]) // drop_oldest
  put(0x2000, word(0x2100)) // readings.buffer_start

  const registers: Record<string, number> = { arg0: 0x2000, pc: 0x8000 }
  const t = {
    reads: 0,
    pointerBytes,
    symbol: (name: string) => symbols[name] ?? null,
    register: (name: string) => registers[name] ?? null,
    async read(addr: number, length: number) {
      t.reads++
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        const byte = memory.get(addr + i)
        if (byte === undefined) return null
        out[i] = byte
      }
      return out
    },
    label: () => null,
  }
  return t
}

function parsed(text: string): PredicateSpec {
  const result = parsePredicate(text)
  if (!result.ok) throw new Error(`${text}: ${result.error}`)
  return result.predicate
}

function error(text: string): string {
  const result = parsePredicate(text)
  if (result.ok) throw new Error(`${text} parsed`)
  return result.error
}

async function evaluate(text: string, t = target()) {
  return evalPredicate(parsed(text), t)
}

describe('parsePredicate', () => {
  it('splits the sides, their formats and the operator', () => {
    expect(parsed('alarms_lost as u32 == 1')).toEqual({
      text: 'alarms_lost as u32 == 1',
      lhs: { expr: 'alarms_lost', format: 'u32', literal: null },
      op: '==',
      rhs: { expr: '1', format: null, literal: 1n },
    })
  })

  it('knows every operator, with or without spaces', () => {
    for (const op of COMPARE_OPS) {
      expect(parsed(`count as u8 ${op} 4`).op).toBe(op)
      expect(parsed(`count as u8${op}4`).op).toBe(op)
    }
  })

  it('reads a side without a format as the number the expression is', () => {
    expect(parsed('$arg0 == readings')).toMatchObject({
      lhs: { expr: '$arg0', format: null, literal: null },
      rhs: { expr: 'readings', format: null, literal: null },
    })
  })

  it('takes decimal, hex and negative numbers, and true and false', () => {
    expect(parsed('x as u32 == 0x10').rhs.literal).toBe(16n)
    expect(parsed('x as i32 == -1').rhs.literal).toBe(-1n)
    expect(parsed('x as i32 > - 2').rhs.literal).toBe(-2n)
    expect(parsed('x as u64 == 0xffffffffffffffff').rhs.literal).toBe(0xffffffffffffffffn)
    expect(parsed('x as bool == true').rhs.literal).toBe(1n)
    expect(parsed('x as bool == false').rhs.literal).toBe(0n)
  })

  it('reads a number with a format as an address, like a watch row', () => {
    expect(parsed('0x40001000 as u32 == 0').lhs).toEqual({
      expr: '0x40001000',
      format: 'u32',
      literal: null,
    })
  })

  it('takes a format in any case and puts it in lowercase', () => {
    expect(parsed('x as U32 == 1').lhs.format).toBe('u32')
  })

  it('reports a row that compares nothing, or more than once', () => {
    expect(error('alarms_lost as u32')).toContain('has no comparison')
    expect(error('alarms_lost as u32 = 1')).toBe('compares with `=`; use `==`')
    expect(error('0 < x as u32 < 4')).toContain('more than one comparison')
    expect(error('x <> 1')).toContain('more than one comparison')
  })

  it('reports a missing side', () => {
    expect(error('== 1')).toBe('has nothing to the left of `==`')
    expect(error('x as u32 >=')).toBe('has nothing to the right of `>=`')
    expect(error('as u32 == 1')).toBe('has nothing to the left of `==`')
  })

  it('reports a format it does not know, or one that is not a number', () => {
    expect(error('x as u37 == 1')).toContain('`as u37` is not a format')
    expect(error('name as string == 0')).toBe(
      '`as string` is not a number, so it cannot be compared',
    )
    expect(error('x as bytes:4 == 0')).toContain('`as bytes:4` is not a number')
  })

  it('reports an expression that would never run, before any guest does', () => {
    expect(error('led + == 1')).toBe('`led +`: expression ends early')
    expect(error('(led == 1')).toBe('`(led`: missing `)`')
    expect(error('led & 3 == 1')).toBe('`led & 3`: not an expression')
    expect(error('x === 1')).toContain('not an expression')
    expect(error('-x as u8 == 1')).toBe('`-x`: unexpected `-`')
  })
})

describe('evalPredicate', () => {
  it('reads a counter and compares it', async () => {
    expect(await evaluate('alarms_lost as u32 == 2')).toEqual({
      pass: true,
      error: null,
      lhs: { value: 2n, text: '2' },
      rhs: { value: 2n, text: '2' },
    })
    expect(await evaluate('alarms_lost as u32 == 1')).toEqual({
      pass: false,
      error: null,
      lhs: { value: 2n, text: '2' },
      rhs: { value: 1n, text: '1' },
    })
  })

  it('applies every operator', async () => {
    const verdicts = await Promise.all(
      ['!= 1', '< 3', '<= 2', '> 2', '>= 2', '== 3'].map(
        async (rest) => (await evaluate(`alarms_lost as u32 ${rest}`)).pass,
      ),
    )
    expect(verdicts).toEqual([true, true, true, false, true, false])
  })

  it('compares an argument register with an address without reading either', async () => {
    const t = target()
    expect(await evaluate('$arg0 == readings', t)).toMatchObject({
      pass: true,
      lhs: { value: 0x2000n, text: '8192 · 0x2000' },
      rhs: { value: 0x2000n, text: '8192 · 0x2000' },
    })
    expect(t.reads).toBe(0)
    expect((await evaluate('$arg0 == ring')).pass).toBe(false)
  })

  it('reads a pointer and compares it with the symbol it should point at', async () => {
    expect((await evaluate('readings as ptr == ring')).pass).toBe(true)
    expect((await evaluate('*$arg0 == ring')).pass).toBe(true)
    expect((await evaluate('readings as ptr == ring', target(8))).pass).toBe(true)
  })

  it('compares whole numbers, so signedness is the format’s to say', async () => {
    expect(await evaluate('ticks as i32 < 0')).toMatchObject({ pass: true, lhs: { value: -1n } })
    expect((await evaluate('ticks as u32 == 0xffffffff')).pass).toBe(true)
    expect((await evaluate('ticks as i32 == 0xffffffff')).pass).toBe(false)
  })

  it('reads a flag as 0 or 1, so it compares with true and false', async () => {
    expect((await evaluate('drop_oldest as bool == true')).pass).toBe(true)
    expect((await evaluate('drop_oldest as bool != false')).pass).toBe(true)
  })

  it('never passes a side it could not read, whatever the operator', async () => {
    expect(await evaluate('lost as u32 != 1')).toEqual({
      pass: false,
      error: 'no symbol `lost`',
      lhs: { value: null, text: 'no symbol `lost`' },
      rhs: { value: 1n, text: '1' },
    })
    expect(await evaluate('0 == 0x9000 as u32')).toMatchObject({ pass: false, error: 'unreadable' })
    expect(await evaluate('$sp == readings')).toMatchObject({
      pass: false,
      error: 'no register $sp',
    })
  })

  it('reads nothing for a bare number', async () => {
    const t = target()
    await evaluate('alarms_lost as u32 == 2', t)
    expect(t.reads).toBe(1)
  })
})

describe('predicateIdentifiers', () => {
  it('lists the symbols and registers a row names, once each, in order', () => {
    expect(predicateIdentifiers(parsed('$sp - stack_top as u32 >= $arg1 + stack_top'))).toEqual({
      symbols: ['stack_top'],
      registers: ['sp', 'arg1'],
      members: [],
    })
  })

  it('names nothing for a bare number', () => {
    expect(predicateIdentifiers(parsed('alarms_lost as u32 == 1'))).toEqual({
      symbols: ['alarms_lost'],
      registers: [],
      members: [],
    })
    expect(predicateIdentifiers(parsed('1 == 1'))).toEqual({ symbols: [], registers: [], members: [] })
  })

  it('lists the struct members a member view needs, apart from the symbols', () => {
    expect(predicateIdentifiers(parsed('k_msgq(readings).used_msgs as u32 >= k_msgq(readings).max_msgs as u32'))).toEqual({
      symbols: ['readings'],
      registers: [],
      members: [
        { struct: 'k_msgq', member: 'used_msgs' },
        { struct: 'k_msgq', member: 'max_msgs' },
      ],
    })
  })
})
