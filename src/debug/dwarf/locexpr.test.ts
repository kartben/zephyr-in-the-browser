import { describe, expect, it } from 'vitest'
import { evaluateLocation, OPTIMIZED_OUT, type ExprContext } from '@/debug/dwarf/locexpr'

function sleb(value: number): number[] {
  const out: number[] = []
  let rest = value
  for (;;) {
    const byte = rest & 0x7f
    rest >>= 7
    if ((rest === 0 && !(byte & 0x40)) || (rest === -1 && byte & 0x40)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

/** A 32-bit target: r0..r15 hold 0x1000 + n, memory holds 0x11223344 everywhere. */
function ctx(over: Partial<ExprContext> = {}): ExprContext {
  return {
    addrSize: 4,
    little: true,
    reg: (n) => (n < 16 ? BigInt(0x1000 + n) : null),
    frameBase: async () => 0x2000_0100n,
    cfa: () => 0x2000_0200n,
    read: async (_addr, size) => new Uint8Array([0x44, 0x33, 0x22, 0x11, 0, 0, 0, 0].slice(0, size)),
    addrx: () => null,
    ...over,
  }
}

const run = (bytes: number[], c = ctx()) => evaluateLocation(new Uint8Array(bytes), c)

describe('evaluateLocation', () => {
  it('names a register', async () => {
    expect(await run([0x54])).toEqual({ kind: 'register', reg: 4 }) // DW_OP_reg4
    expect(await run([0x90, 0x21])).toEqual({ kind: 'register', reg: 33 }) // DW_OP_regx 33
  })

  it('computes addresses from registers, the frame base and the CFA', async () => {
    expect(await run([0x7d, ...sleb(-8)])).toEqual({ kind: 'memory', addr: 0x1005n }) // breg13 -8
    expect(await run([0x91, ...sleb(-24)])).toEqual({ kind: 'memory', addr: 0x2000_00e8n }) // fbreg -24
    expect(await run([0x9c, 0x23, 0x10])).toEqual({ kind: 'memory', addr: 0x2000_0210n }) // cfa; plus_uconst 16
    expect(await run([0x03, 0x00, 0x10, 0x00, 0x20])).toEqual({ kind: 'memory', addr: 0x2000_1000n }) // addr
  })

  it('reads memory for deref', async () => {
    expect(await run([0x03, 0, 0, 0, 0x20, 0x06])).toEqual({ kind: 'memory', addr: 0x11223344n })
    expect(await run([0x03, 0, 0, 0, 0x20, 0x94, 2])).toEqual({ kind: 'memory', addr: 0x3344n })
  })

  it('knows a computed value from a stored one', async () => {
    // breg0 4; stack_value: the value is r0 + 4, it lives nowhere.
    expect(await run([0x70, 4, 0x9f])).toEqual({ kind: 'value', value: 0x1004n })
    expect(await run([0x9e, 2, 0xab, 0xcd])).toEqual({ kind: 'implicit', bytes: new Uint8Array([0xab, 0xcd]) })
  })

  it('does arithmetic in the address width', async () => {
    // lit0; lit1; minus; stack_value → 0xffffffff on a 32-bit target
    expect(await run([0x30, 0x31, 0x1c, 0x9f])).toEqual({ kind: 'value', value: 0xffff_ffffn })
    // lit5; lit3; mul; lit2; shl; stack_value → 60
    expect(await run([0x35, 0x33, 0x1e, 0x32, 0x24, 0x9f])).toEqual({ kind: 'value', value: 60n })
  })

  it('branches relative to the end of the operand', async () => {
    // lit1; bra +1 (taken, over lit7); lit2; skip +1 (over lit8); lit3; plus
    const expr = [0x31, 0x28, 1, 0, 0x37, 0x32, 0x2f, 1, 0, 0x38, 0x33, 0x22, 0x9f]
    expect(await run(expr)).toEqual({ kind: 'value', value: 5n })
  })

  it('shifts past the width to zero, as GCC sometimes asks', async () => {
    // breg0 0; const1s -2; shl: the count reads as 0xfffffffe.
    expect(await run([0x70, 0, 0x09, 0xfe, 0x24, 0x9f])).toEqual({ kind: 'value', value: 0n })
    expect(await run([0x70, 0, 0x09, 0xfe, 0x25, 0x9f])).toEqual({ kind: 'value', value: 0n })
  })

  it('splits a variable into pieces', async () => {
    // reg0 piece 4; reg1 piece 4: a 64-bit value in r0:r1
    expect(await run([0x50, 0x93, 4, 0x51, 0x93, 4])).toEqual({
      kind: 'pieces',
      pieces: [
        { loc: { kind: 'register', reg: 0 }, bytes: 4 },
        { loc: { kind: 'register', reg: 1 }, bytes: 4 },
      ],
    })
    // piece 4 with nothing before it: that half was optimized out.
    expect(await run([0x93, 4, 0x51, 0x93, 4])).toMatchObject({
      kind: 'pieces',
      pieces: [{ loc: null, bytes: 4 }, { loc: { kind: 'register', reg: 1 } }],
    })
  })

  it('reads an entry value as optimized out, as GDB does when it cannot recover one', async () => {
    // DW_OP_entry_value(DW_OP_regval_type r0 ...), convert, convert, stack_value
    const expr = [0xa3, 3, 0xa5, 0, 0x26, 0xa8, 0x2d, 0xa8, 0, 0x9f]
    expect(await run(expr)).toEqual({ kind: 'unavailable', reason: OPTIMIZED_OUT })
    expect(await run([])).toEqual({ kind: 'unavailable', reason: OPTIMIZED_OUT })
  })

  it('says why when a register or memory is out of reach', async () => {
    expect(await run([0x8f, 0])).toMatchObject({ kind: 'unavailable' }) // breg31: no such register here
    const unreadable = ctx({ read: async () => null })
    expect(await run([0x03, 0, 0, 0, 0x20, 0x06], unreadable)).toEqual({
      kind: 'unavailable',
      reason: 'cannot read 0x20000000',
    })
  })
})
