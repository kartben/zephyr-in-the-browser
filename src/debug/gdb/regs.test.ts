import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@/debug/gdb/rspCodec'
import { archFromElf, codeAddr, decodeGPacket } from '@/debug/gdb/regs'

/**
 * The `g` packet is a flat blob whose meaning is pure offset arithmetic, and
 * the call stack is built from four of those offsets. Getting one wrong yields
 * a plausible-looking wrong stack, so pin them.
 */
function packet(size: number, words: { at: number; width: 4 | 8; value: number }[]): string {
  const bytes = new Uint8Array(size)
  for (const { at, width, value } of words) {
    let v = value
    for (let i = 0; i < width; i++) {
      bytes[at + i] = v % 256
      v = Math.floor(v / 256)
    }
  }
  return bytesToHex(bytes)
}

describe('decodeGPacket frame registers', () => {
  it('reads pc / sp / x29 / x30 from an aarch64 blob', () => {
    const hex = packet(268, [
      { at: 29 * 8, width: 8, value: 0x4000_1020 }, // x29 = fp
      { at: 30 * 8, width: 8, value: 0x4001_a044 }, // x30 = lr
      { at: 31 * 8, width: 8, value: 0x4000_1000 }, // sp
      { at: 32 * 8, width: 8, value: 0x4003_b018 }, // pc
    ])
    const view = decodeGPacket('aarch64', hex)

    expect(view.pc).toBe('000000004003b018')
    expect(view.frame).toEqual({
      pc: 0x4003_b018,
      sp: 0x4000_1000,
      fp: 0x4000_1020,
      lr: 0x4001_a044,
    })
  })

  it('reads r7 / r13 / r14 / r15 from an arm blob', () => {
    const hex = packet(68, [
      { at: 7 * 4, width: 4, value: 0x2000_0120 }, // r7 = thumb frame pointer
      { at: 13 * 4, width: 4, value: 0x2000_0100 }, // sp
      { at: 14 * 4, width: 4, value: 0x0000_8145 }, // lr, Thumb bit set
      { at: 15 * 4, width: 4, value: 0x0000_8211 },
    ])
    const view = decodeGPacket('arm', hex)

    expect(view.frame.fp).toBe(0x2000_0120)
    expect(view.frame.sp).toBe(0x2000_0100)
    expect(codeAddr('arm', view.frame.lr!)).toBe(0x0000_8144)
  })

  it('reads ra / sp / s0 / pc from a riscv32 blob', () => {
    const hex = packet(132, [
      { at: 1 * 4, width: 4, value: 0x8000_1234 }, // ra
      { at: 2 * 4, width: 4, value: 0x8000_f000 }, // sp
      { at: 8 * 4, width: 4, value: 0x8000_f040 }, // s0 = fp
      { at: 32 * 4, width: 4, value: 0x8000_2000 }, // pc
    ])
    const view = decodeGPacket('riscv32', hex)

    expect(view.frame).toEqual({
      pc: 0x8000_2000,
      sp: 0x8000_f000,
      fp: 0x8000_f040,
      lr: 0x8000_1234,
    })
  })

  it('reports no frame registers when the blob is short', () => {
    expect(decodeGPacket('aarch64', '00').frame).toEqual({
      pc: null,
      sp: null,
      fp: null,
      lr: null,
    })
  })
})

describe('archFromElf', () => {
  /** A minimal ELF header: magic, class, LE data, e_machine at 0x12. */
  function header(machine: number, elfClass: 1 | 2 = 1): Uint8Array {
    const bytes = new Uint8Array(0x20)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1], 0)
    bytes[0x12] = machine & 0xff
    bytes[0x13] = machine >> 8
    return bytes
  }

  it('maps the three wired machines', () => {
    expect(archFromElf(header(40))).toBe('arm')
    expect(archFromElf(header(183, 2))).toBe('aarch64')
    expect(archFromElf(header(243, 1))).toBe('riscv32')
  })

  it('declines 64-bit RISC-V and unknown machines', () => {
    expect(archFromElf(header(243, 2))).toBeNull() // rv64: no decoder
    expect(archFromElf(header(94))).toBeNull() // Xtensa/ESP32
  })

  it('declines non-ELF bytes', () => {
    expect(archFromElf(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
