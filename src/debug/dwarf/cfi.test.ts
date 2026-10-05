import { describe, expect, it } from 'vitest'
import { CallFrameInfo } from '@/debug/dwarf/cfi'

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

/** A length-prefixed `.debug_frame` entry. */
function entry(body: number[]): number[] {
  return [...u32(body.length), ...body]
}

/**
 * One CIE (CFA = r13, code alignment 1, data alignment -4, return address in
 * r14) and two FDEs: a real function at 0x1000, and a dropped one the linker
 * relocated to 0, as `--gc-sections` leaves them.
 */
function debugFrame(): Uint8Array {
  const cie = entry([
    ...u32(0xffffffff), // CIE id
    3, // version
    0, // augmentation ""
    1, // code alignment
    0x7c, // data alignment -4
    14, // return address register
    0x0c, 13, 0, // def_cfa r13+0
  ])
  const fde = entry([
    ...u32(0), // CIE pointer
    ...u32(0x1000),
    ...u32(0x40),
    0x40 | 2, // advance_loc 2 → 0x1002
    0x0e, 8, // def_cfa_offset 8
    0x80 | 14, 1, // offset r14 at cfa-4
    0x40 | 4, // advance_loc 4 → 0x1006
    0x0a, // remember_state
    0x0d, 7, // def_cfa_register r7
    0x40 | 8, // advance_loc 8 → 0x100e
    0x0b, // restore_state
  ])
  const dropped = entry([...u32(0), ...u32(0), ...u32(0x2000), 0x0e, 99])
  return new Uint8Array([...cie, ...fde, ...dropped])
}

describe('CallFrameInfo', () => {
  const cfi = CallFrameInfo.parse(debugFrame(), 4)!

  it('starts each function from the CIE rule', () => {
    expect(cfi.rowAt(0x1000)?.cfa).toEqual({ kind: 'reg', reg: 13, offset: 0 })
    expect(cfi.rowAt(0x1001)?.cfa).toEqual({ kind: 'reg', reg: 13, offset: 0 })
    expect(cfi.rowAt(0x1000)?.returnReg).toBe(14)
  })

  it('applies each rule from the instruction it is attached to', () => {
    const row = cfi.rowAt(0x1002)!
    expect(row.cfa).toEqual({ kind: 'reg', reg: 13, offset: 8 })
    expect(row.regs.get(14)).toEqual({ kind: 'offset', offset: -4 })
    expect(cfi.rowAt(0x1006)?.cfa).toEqual({ kind: 'reg', reg: 7, offset: 8 })
  })

  it('restores remembered state', () => {
    expect(cfi.rowAt(0x100e)?.cfa).toEqual({ kind: 'reg', reg: 13, offset: 8 })
    expect(cfi.rowAt(0x103f)?.cfa).toEqual({ kind: 'reg', reg: 13, offset: 8 })
  })

  it('covers only the functions it describes', () => {
    expect(cfi.rowAt(0x1040)).toBeNull()
    // The dropped function's FDE claims [0, 0x2000), over the real one.
    expect(cfi.rowAt(0x500)).toBeNull()
  })

  it('is absent without a section', () => {
    expect(CallFrameInfo.parse(null, 4)).toBeNull()
    expect(CallFrameInfo.parse(new Uint8Array(0), 4)).toBeNull()
  })
})
