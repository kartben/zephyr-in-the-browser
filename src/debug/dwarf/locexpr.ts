/**
 * DWARF location expressions: the stack machine that says where a variable is.
 *
 * `DW_OP_reg4` is "in r4"; `DW_OP_fbreg -24` is "24 bytes below the frame
 * base"; `DW_OP_addr 0x20001000` is a global. Composite variables are pieces of
 * those. Values are bigints wrapped to the target's address width, the
 * "generic type" the specification evaluates in.
 *
 * What it does not do is recover a value the optimiser threw away.
 * `DW_OP_entry_value` asks for what a register held when the function was
 * entered, which only the caller's call site can answer (GDB tries; it needs
 * caller-frame unwinding, which this page does not do yet), so it reads as
 * optimized out, which is what GDB prints whenever its own attempt fails.
 */

import { DwarfReader } from '@/debug/dwarf/reader'

export type Location =
  | { kind: 'memory'; addr: bigint }
  | { kind: 'register'; reg: number }
  | { kind: 'value'; value: bigint }
  | { kind: 'implicit'; bytes: Uint8Array }
  | { kind: 'pieces'; pieces: Piece[] }
  | { kind: 'unavailable'; reason: string }

export interface Piece {
  /** Null for a piece the compiler left undescribed (optimized out). */
  loc: Location | null
  bytes: number
}

export interface ExprContext {
  addrSize: number
  little: boolean
  /** A register's value by DWARF number, or null when it cannot be read. */
  reg(n: number): bigint | null
  /** The enclosing function's frame base, already evaluated. */
  frameBase(): Promise<bigint | null>
  /** The canonical frame address at the PC, from `.debug_frame`. */
  cfa(): bigint | null
  read(addr: bigint, size: number): Promise<Uint8Array | null>
  /** Resolve a `.debug_addr` index (DW_OP_addrx / constx). */
  addrx(index: number): number | null
}

export const OPTIMIZED_OUT = 'optimized out'

class Unavailable extends Error {}

export async function evaluateLocation(expr: Uint8Array, ctx: ExprContext): Promise<Location> {
  try {
    return await run(expr, ctx)
  } catch (err) {
    if (err instanceof Unavailable) return { kind: 'unavailable', reason: err.message }
    return { kind: 'unavailable', reason: 'location not understood' }
  }
}

async function run(expr: Uint8Array, ctx: ExprContext): Promise<Location> {
  if (expr.length === 0) return { kind: 'unavailable', reason: OPTIMIZED_OUT }
  const bits = BigInt(ctx.addrSize * 8)
  const mask = (1n << bits) - 1n
  const wrap = (v: bigint) => v & mask
  const signed = (v: bigint) => BigInt.asIntN(Number(bits), v)
  const r = new DwarfReader(expr, 0, ctx.little)
  const stack: bigint[] = []
  const pieces: Piece[] = []

  /* What the expression has said since the last piece, besides the stack. */
  let inReg: number | null = null
  let stackValue = false
  let implicit: Uint8Array | null = null

  const pop = (): bigint => {
    const v = stack.pop()
    if (v === undefined) throw new Error('stack underflow')
    return v
  }
  const push = (v: bigint) => stack.push(wrap(v))
  const regValue = (n: number): bigint => {
    const v = ctx.reg(n)
    if (v === null) throw new Unavailable(`register ${n} not available`)
    return v
  }
  const deref = async (addr: bigint, size: number): Promise<bigint> => {
    const bytes = await ctx.read(addr, size)
    if (!bytes || bytes.length < size) throw new Unavailable(`cannot read 0x${addr.toString(16)}`)
    let v = 0n
    for (let i = 0; i < size; i++) {
      const byte = BigInt(bytes[ctx.little ? i : size - 1 - i]!)
      v |= byte << BigInt(8 * i)
    }
    return v
  }
  /** The location described since the last piece. */
  const current = (): Location | null => {
    if (inReg !== null) return { kind: 'register', reg: inReg }
    if (implicit) return { kind: 'implicit', bytes: implicit }
    if (stack.length === 0) return null
    const top = stack[stack.length - 1]!
    return stackValue ? { kind: 'value', value: top } : { kind: 'memory', addr: top }
  }
  const resetPiece = () => {
    inReg = null
    stackValue = false
    implicit = null
    stack.length = 0
  }

  while (!r.done) {
    const op = r.u8()
    if (op >= 0x30 && op <= 0x4f) {
      push(BigInt(op - 0x30)) // lit0..lit31
      continue
    }
    if (op >= 0x50 && op <= 0x6f) {
      inReg = op - 0x50 // reg0..reg31
      continue
    }
    if (op >= 0x70 && op <= 0x8f) {
      const offset = r.slebBig() // breg0..breg31
      push(regValue(op - 0x70) + offset)
      continue
    }
    switch (op) {
      case 0x03: // addr
        push(ctx.addrSize === 8 ? r.u64Big() : BigInt(r.u32()))
        break
      case 0x06: // deref
        push(await deref(pop(), ctx.addrSize))
        break
      case 0x08:
        push(BigInt(r.u8()))
        break
      case 0x09:
        push(BigInt(r.i8()))
        break
      case 0x0a:
        push(BigInt(r.u16()))
        break
      case 0x0b:
        push(BigInt(r.i16()))
        break
      case 0x0c:
        push(BigInt(r.u32()))
        break
      case 0x0d:
        push(BigInt(r.i32()))
        break
      case 0x0e:
        push(r.u64Big())
        break
      case 0x0f:
        push(BigInt.asIntN(64, r.u64Big()))
        break
      case 0x10: // constu
        push(r.ulebBig())
        break
      case 0x11: // consts
        push(r.slebBig())
        break
      case 0x12: {
        // dup
        const v = pop()
        stack.push(v, v)
        break
      }
      case 0x13: // drop
        pop()
        break
      case 0x14: // over
        if (stack.length < 2) throw new Error('stack underflow')
        stack.push(stack[stack.length - 2]!)
        break
      case 0x15: {
        // pick
        const index = r.u8()
        const v = stack[stack.length - 1 - index]
        if (v === undefined) throw new Error('stack underflow')
        stack.push(v)
        break
      }
      case 0x16: {
        // swap
        const a = pop()
        const b = pop()
        stack.push(a, b)
        break
      }
      case 0x17: {
        // rot
        const a = pop()
        const b = pop()
        const c = pop()
        stack.push(a, c, b)
        break
      }
      case 0x19: {
        // abs
        const v = signed(pop())
        push(v < 0n ? -v : v)
        break
      }
      case 0x1a: {
        const b = pop()
        push(pop() & b)
        break
      }
      case 0x1b: {
        // div (signed)
        const b = signed(pop())
        const a = signed(pop())
        if (b === 0n) throw new Unavailable('division by zero')
        push(a / b)
        break
      }
      case 0x1c: {
        const b = pop()
        push(pop() - b)
        break
      }
      case 0x1d: {
        const b = pop()
        const a = pop()
        if (b === 0n) throw new Unavailable('division by zero')
        push(a % b)
        break
      }
      case 0x1e: {
        const b = pop()
        push(pop() * b)
        break
      }
      case 0x1f:
        push(-pop())
        break
      case 0x20:
        push(~pop())
        break
      case 0x21: {
        const b = pop()
        push(pop() | b)
        break
      }
      case 0x22: {
        const b = pop()
        push(pop() + b)
        break
      }
      case 0x23: // plus_uconst
        push(pop() + r.ulebBig())
        break
      case 0x24: {
        // Shifts past the width give 0, and GCC does emit them (a negative
        // const1s count, read unsigned); BigInt would grow without end.
        const b = pop()
        const a = pop()
        push(b >= bits ? 0n : a << b)
        break
      }
      case 0x25: {
        const b = pop()
        const a = pop()
        push(b >= bits ? 0n : a >> b)
        break
      }
      case 0x26: {
        const b = pop()
        const a = signed(pop())
        push(b >= bits ? (a < 0n ? -1n : 0n) : a >> b)
        break
      }
      case 0x27: {
        const b = pop()
        push(pop() ^ b)
        break
      }
      case 0x28: {
        // bra
        const skip = r.i16()
        if (pop() !== 0n) r.at += skip
        break
      }
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c:
      case 0x2d:
      case 0x2e: {
        const b = signed(pop())
        const a = signed(pop())
        const result =
          op === 0x29 ? a === b
          : op === 0x2a ? a >= b
          : op === 0x2b ? a > b
          : op === 0x2c ? a <= b
          : op === 0x2d ? a < b
          : a !== b
        push(result ? 1n : 0n)
        break
      }
      case 0x2f: {
        // skip: relative to the end of its operand, so read that first
        const skip = r.i16()
        r.at += skip
        break
      }
      case 0x90: // regx
        inReg = r.uleb()
        break
      case 0x91: {
        // fbreg
        const offset = r.slebBig()
        const base = await ctx.frameBase()
        if (base === null) throw new Unavailable('frame base not available')
        push(base + offset)
        break
      }
      case 0x92: {
        // bregx
        const reg = r.uleb()
        push(regValue(reg) + r.slebBig())
        break
      }
      case 0x93: {
        // piece
        const size = r.uleb()
        pieces.push({ loc: current(), bytes: size })
        resetPiece()
        break
      }
      case 0x94: {
        // deref_size
        const size = r.u8()
        push(await deref(pop(), size))
        break
      }
      case 0x96: // nop
        break
      case 0x9c: {
        // call_frame_cfa
        const cfa = ctx.cfa()
        if (cfa === null) throw new Unavailable('frame address not available')
        push(cfa)
        break
      }
      case 0x9d: {
        // bit_piece: whole bytes only, which is all GCC emits for C variables
        const sizeBits = r.uleb()
        r.uleb() // offset
        pieces.push({ loc: current(), bytes: Math.ceil(sizeBits / 8) })
        resetPiece()
        break
      }
      case 0x9e: // implicit_value
        implicit = r.bytes(r.uleb())
        break
      case 0x9f: // stack_value
        stackValue = true
        break
      case 0xa1: {
        // addrx
        const a = ctx.addrx(r.uleb())
        if (a === null) throw new Error('address index out of range')
        push(BigInt(a))
        break
      }
      case 0xa2: {
        // constx
        const a = ctx.addrx(r.uleb())
        if (a === null) throw new Error('address index out of range')
        push(BigInt(a))
        break
      }
      case 0xa4:
      case 0xf4: {
        // const_type: the constant's bytes, read as an integer
        r.uleb()
        const size = r.u8()
        const bytes = r.bytes(size)
        let v = 0n
        for (let i = 0; i < Math.min(size, 8); i++) v |= BigInt(bytes[i]!) << BigInt(8 * i)
        push(v)
        break
      }
      case 0xa5:
      case 0xf5: {
        // regval_type
        const reg = r.uleb()
        r.uleb()
        push(regValue(reg))
        break
      }
      case 0xa6:
      case 0xf6: {
        // deref_type
        const size = r.u8()
        r.uleb()
        push(await deref(pop(), size))
        break
      }
      case 0xa8:
      case 0xa9:
      case 0xf7:
      case 0xf9: // convert / reinterpret: the generic type is all this reads in
        r.uleb()
        break
      case 0xf0: // GNU_uninit: a marker, the value is still where it says
        break
      case 0xa3: // entry_value
      case 0xf3: // GNU_entry_value
      case 0xa0: // implicit_pointer
      case 0xf2: // GNU_implicit_pointer
      case 0xfa: // GNU_parameter_ref
      case 0xfd: // GNU_variable_value
        throw new Unavailable(OPTIMIZED_OUT)
      default:
        throw new Unavailable(`DW_OP 0x${op.toString(16)} not supported`)
    }
  }

  if (pieces.length > 0) {
    // Trailing operations with no piece after them describe nothing.
    return { kind: 'pieces', pieces }
  }
  return current() ?? { kind: 'unavailable', reason: OPTIMIZED_OUT }
}
