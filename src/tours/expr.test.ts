import { describe, expect, it } from 'vitest'
import {
  evalAddress,
  evalValue,
  evalWatch,
  expressionError,
  expressionNames,
  isKnownFormat,
  isNumberFormat,
  type TourTarget,
} from '@/tours/expr'

/**
 * A pretend guest: `led` at 0x2000 holding a pointer to a `struct device` at
 * 0x3000, whose first field points at the string "gpio@9030000". `ticks` at
 * 0x5000 is a counter that has gone to -1.
 */
function target(pointerBytes: 4 | 8 = 4): TourTarget {
  const memory = new Map<number, Uint8Array>()
  const word = (value: number) => {
    const out = new Uint8Array(pointerBytes)
    for (let i = 0; i < pointerBytes; i++) out[i] = (value >>> (i * 8)) & 0xff
    return out
  }
  const put = (addr: number, bytes: Uint8Array) => {
    bytes.forEach((b, i) => memory.set(addr + i, new Uint8Array([b])))
  }
  put(0x2000, word(0x3000)) // led.port
  put(0x2000 + pointerBytes, new Uint8Array([4, 0, 0x01, 0x00])) // pin 4, flags 1
  put(0x3000, word(0x4000)) // device.name
  put(0x4000, new Uint8Array([...[...'gpio@9030000'].map((c) => c.charCodeAt(0)), 0]))
  put(0x5000, new Uint8Array([0xff, 0xff, 0xff, 0xff])) // ticks

  const symbols: Record<string, number> = { led: 0x2000, main: 0x8100, ticks: 0x5000 }
  return {
    pointerBytes,
    symbol: (name) => symbols[name] ?? null,
    register: (name) => (name === 'pc' ? 0x8123 : null),
    async read(addr, length) {
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        const byte = memory.get(addr + i)
        if (!byte) return null
        out[i] = byte[0]!
      }
      return out
    },
    label: (addr) => (addr >= 0x8100 && addr < 0x8200 ? `main+0x${(addr - 0x8100).toString(16)}` : null),
  }
}

describe('evalAddress', () => {
  it('resolves symbols to where they live, not what they hold', async () => {
    expect(await evalAddress('led', target())).toBe(0x2000)
  })

  it('follows a pointer with `*`', async () => {
    expect(await evalAddress('*led', target())).toBe(0x3000)
    expect(await evalAddress('**led', target())).toBe(0x4000)
  })

  it('does arithmetic, with parens and registers', async () => {
    const t = target()
    expect(await evalAddress('led+4', t)).toBe(0x2004)
    expect(await evalAddress('*(led + 0)', t)).toBe(0x3000)
    expect(await evalAddress('$pc - 0x23', t)).toBe(0x8100)
  })

  it('scales `p` by the guest pointer width', async () => {
    expect(await evalAddress('led+1p', target(4))).toBe(0x2004)
    expect(await evalAddress('led+1p', target(8))).toBe(0x2008)
    expect(await evalAddress('led+2p+2', target(8))).toBe(0x2012)
  })

  it('refuses what it cannot resolve', async () => {
    await expect(evalAddress('nope', target())).rejects.toThrow('no symbol')
    await expect(evalAddress('$sp', target())).rejects.toThrow('no register')
    await expect(evalAddress('led +', target())).rejects.toThrow()
    await expect(evalAddress('led & 3', target())).rejects.toThrow()
  })
})

describe('evalWatch', () => {
  it('reads an integer at the address the expression names', async () => {
    expect(await evalWatch('led+1p', 'u8', target())).toMatchObject({ text: '4', ok: true })
    expect(await evalWatch('led+1p+2', 'u16', target())).toMatchObject({ text: '1', ok: true })
  })

  it('shows large values in decimal and hex', async () => {
    expect((await evalWatch('led', 'u32', target())).text).toBe('12288 · 0x3000')
  })

  it('reads a C string through two pointers', async () => {
    expect(await evalWatch('**led', 'string', target())).toMatchObject({
      text: '"gpio@9030000"',
      ok: true,
    })
  })

  it('labels an address instead of reading it', async () => {
    expect(await evalWatch('$pc', 'code', target())).toMatchObject({
      text: 'main+0x23',
      detail: '0x8123',
    })
    expect(await evalWatch('led', 'addr', target())).toMatchObject({ text: '0x2000' })
  })

  it('gives back the value itself for `dec`, without reading through it', async () => {
    // An argument register holding a stack size is a number, not a place: `u32`
    // would go looking for memory at 2048 and report it as unreadable.
    expect(await evalWatch('2048', 'dec', target())).toMatchObject({
      text: '2048 · 0x800',
      ok: true,
    })
    expect((await evalWatch('4', 'dec', target())).text).toBe('4')
    expect((await evalWatch('2048', 'u32', target())).ok).toBe(false)
  })

  it('follows a pointer for `ptr` and hexdumps for `bytes:N`', async () => {
    expect((await evalWatch('led', 'ptr', target())).text).toBe('0x3000')
    expect((await evalWatch('led+1p', 'bytes:4', target())).text).toBe('04 00 01 00')
  })

  it('turns a failure into a value rather than an exception', async () => {
    expect(await evalWatch('nope', 'u32', target())).toMatchObject({ ok: false })
    expect(await evalWatch('0x9999', 'u32', target())).toMatchObject({
      ok: false,
      text: 'unreadable',
    })
    expect(await evalWatch('led', 'u37', target())).toMatchObject({ ok: false })
  })
})

describe('member views', () => {
  /**
   * `struct k_msgq` as the DWARF of two builds lays it out: `used_msgs` moves
   * with the pointer width, and Kconfig moves it again on the same board.
   */
  const LAYOUTS: Record<4 | 8, Record<string, number>> = {
    4: { wait_q: 0, lock: 8, msg_size: 8, max_msgs: 12, buffer_start: 16, used_msgs: 32 },
    8: { wait_q: 0, lock: 16, msg_size: 16, max_msgs: 24, buffer_start: 32, used_msgs: 64 },
  }

  function typed(pointerBytes: 4 | 8): TourTarget {
    const base = target(pointerBytes)
    return {
      ...base,
      symbol: (name) => (name === 'readings' ? 0x5000 : base.symbol(name)),
      member: (struct, member) => (struct === 'k_msgq' ? (LAYOUTS[pointerBytes][member] ?? null) : null),
    }
  }

  it('names a member by the offset the build says it has', async () => {
    expect(await evalAddress('k_msgq(readings).used_msgs', typed(4))).toBe(0x5020)
    expect(await evalAddress('k_msgq(readings).used_msgs', typed(8))).toBe(0x5040)
  })

  it('takes any expression for the struct address', async () => {
    // `*led` is 0x3000; the view does not care how the address was reached.
    expect(await evalAddress('k_msgq(*led).max_msgs', typed(4))).toBe(0x300c)
    expect(await evalAddress('k_msgq(readings + 0).wait_q', typed(8))).toBe(0x5000)
  })

  it('composes with the rest of the language', async () => {
    const t = typed(4)
    expect(await evalAddress('k_msgq(readings).buffer_start + 4', t)).toBe(0x5014)
    expect(await evalAddress('k_msgq(k_msgq(readings).wait_q).used_msgs', t)).toBe(0x5020)
  })

  it('refuses a member the build does not describe, or a view without one', async () => {
    await expect(evalAddress('k_msgq(readings).nope', typed(4))).rejects.toThrow(
      'no member `nope` in `struct k_msgq`',
    )
    await expect(evalAddress('k_mutex(readings).owner', typed(4))).rejects.toThrow('no member')
    await expect(evalAddress('k_msgq(readings)', typed(4))).rejects.toThrow('needs a member')
    await expect(evalAddress('k_msgq(readings).wait_q.waitq', typed(4))).rejects.toThrow('one member')
    await expect(evalAddress('(readings).used_msgs', typed(4))).rejects.toThrow('struct named')
  })

  it('cannot be read on a target with no type information', async () => {
    await expect(evalAddress('k_msgq(led).used_msgs', target())).rejects.toThrow('no member')
  })

  it('reads through `as`, like any other place', async () => {
    const t = typed(4)
    const memory = new Map([[0x5020, 7]])
    t.read = async (addr, length) =>
      memory.has(addr) ? new Uint8Array([memory.get(addr)!, 0, 0, 0]).slice(0, length) : null
    expect(await evalWatch('k_msgq(readings).used_msgs', 'u32', t)).toMatchObject({ text: '7', ok: true })
  })
})

describe('evalValue', () => {
  it('reads the number a watch row would show, and shows it the same way', async () => {
    const t = target()
    expect(await evalValue('led+1p', 'u8', t)).toEqual({ value: 4n, text: '4' })
    expect(await evalValue('led', 'u32', t)).toEqual({ value: 0x3000n, text: '12288 · 0x3000' })
    expect((await evalWatch('led', 'u32', t)).value).toBe(0x3000n)
  })

  it('sign-extends the signed formats and not the others', async () => {
    const t = target()
    expect(await evalValue('ticks', 'i32', t)).toEqual({ value: -1n, text: '-1' })
    expect((await evalValue('ticks', 'u32', t)).value).toBe(0xffffffffn)
    expect((await evalValue('ticks', 'i8', t)).value).toBe(-1n)
  })

  it('reads pointers, flags and characters as numbers', async () => {
    const t = target()
    expect((await evalValue('led', 'ptr', t)).value).toBe(0x3000n)
    expect(await evalValue('led+1p+2', 'bool', t)).toEqual({ value: 1n, text: 'true' })
    expect(await evalValue('**led', 'char', t)).toEqual({ value: 103n, text: "'g'" })
  })

  it('gives the number itself for `dec`, `addr` and `code`', async () => {
    const t = target()
    expect((await evalValue('led', 'dec', t)).value).toBe(0x2000n)
    expect((await evalValue('led+1p', 'addr', t)).value).toBe(0x2004n)
    expect(await evalValue('$pc', 'code', t)).toEqual({ value: 0x8123n, text: 'main+0x23' })
  })

  it('has no number for a string or a hexdump, and says so', async () => {
    expect(await evalValue('**led', 'string', target())).toEqual({
      value: null,
      text: '`as string` is not a number',
    })
    expect((await evalValue('led', 'bytes:4', target())).value).toBeNull()
  })

  it('says why there is no number when the read fails', async () => {
    expect(await evalValue('nope', 'u32', target())).toEqual({
      value: null,
      text: 'no symbol `nope`',
    })
    expect(await evalValue('0x9999', 'u32', target())).toEqual({ value: null, text: 'unreadable' })
  })
})

describe('expressionError', () => {
  it('accepts what the evaluator can run', () => {
    for (const ok of ['led', 'led+1p', '**led', '*(led + 0)', '$pc - 0x23', '0x40001000']) {
      expect(expressionError(ok), ok).toBeNull()
    }
  })

  it('names what is wrong with what it cannot, without a guest', () => {
    expect(expressionError('led +')).toBe('expression ends early')
    expect(expressionError('(led')).toBe('missing `)`')
    expect(expressionError('led led')).toBe('trailing input')
    expect(expressionError(')')).toBe('unexpected `)`')
    expect(expressionError('led & 3')).toBe('not an expression')
    expect(expressionError('')).toBe('not an expression')
  })

  it('leaves symbols and registers to the stop', () => {
    // Whether `nope` exists is a fact about a build, not about the grammar.
    expect(expressionError('nope + $nothing')).toBeNull()
  })

  it('checks a member view’s shape, and leaves the member to the build', () => {
    expect(expressionError('k_msgq(*$arg0).used_msgs + 1p')).toBeNull()
    expect(expressionError('k_msgq(readings).no_such_member')).toBeNull()
    expect(expressionError('k_msgq(readings)')).toContain('needs a member')
    expect(expressionError('k_msgq(readings).wait_q.waitq')).toContain('one member')
    expect(expressionError('(readings).used_msgs')).toContain('struct named')
    expect(expressionError('.used_msgs')).toContain('needs a struct')
  })
})

describe('expressionNames', () => {
  it('lists symbols and registers once each, in the order written', () => {
    expect(expressionNames('*(led + 1p) - $PC + led + _kernel')).toEqual({
      symbols: ['led', '_kernel'],
      registers: ['pc'],
      members: [],
    })
  })

  it('lists member views apart from symbols, the outer one first', () => {
    expect(expressionNames('outer(inner(*readings).a).b + inner(q).a')).toEqual({
      symbols: ['readings', 'q'],
      registers: [],
      members: [
        { struct: 'outer', member: 'b' },
        { struct: 'inner', member: 'a' },
      ],
    })
  })

  it('names nothing for a number, and gives up on what does not parse', () => {
    expect(expressionNames('0x40 + 2p')).toEqual({ symbols: [], registers: [], members: [] })
    expect(expressionNames('led +')).toBeNull()
  })
})

describe('isKnownFormat', () => {
  it('knows the vocabulary, including the counted hexdump', () => {
    expect(isKnownFormat('u8')).toBe(true)
    expect(isKnownFormat('string')).toBe(true)
    expect(isKnownFormat('bytes:12')).toBe(true)
    expect(isKnownFormat('bytes')).toBe(false)
    expect(isKnownFormat('u37')).toBe(false)
  })
})

describe('isNumberFormat', () => {
  it('takes every format that comes to one number', () => {
    for (const format of ['u8', 'i64', 'bool', 'char', 'ptr', 'addr', 'code', 'dec']) {
      expect(isNumberFormat(format), format).toBe(true)
    }
    for (const format of ['string', 'bytes:4', 'u37', 'constructor']) {
      expect(isNumberFormat(format), format).toBe(false)
    }
  })
})
