import { describe, expect, it } from 'vitest'
import { checksum, decodeStream, encodePacket, hexToBytes, bytesToHex } from '@/debug/gdb/rspCodec'
import { decodeGPacket } from '@/debug/gdb/regs'

describe('rspCodec', () => {
  it('checksums payload bytes', () => {
    expect(checksum('')).toBe('00')
    expect(checksum('g')).toBe('67')
    expect(encodePacket('g')).toBe('$g#67')
  })

  it('decodes ack and packets from a stream', () => {
    const { messages, rest } = decodeStream('+'+encodePacket('OK')+'+'+encodePacket('S05'))
    expect(rest).toBe('')
    expect(messages).toEqual([
      { kind: 'ack' },
      { kind: 'packet', payload: 'OK' },
      { kind: 'ack' },
      { kind: 'packet', payload: 'S05' },
    ])
  })

  it('holds a partial packet in rest', () => {
    const { messages, rest } = decodeStream('$g#6')
    expect(messages).toEqual([])
    expect(rest).toBe('$g#6')
  })

  it('round-trips hex bytes', () => {
    const bytes = hexToBytes('0a0b0cff')
    expect(Array.from(bytes)).toEqual([10, 11, 12, 255])
    expect(bytesToHex(bytes)).toBe('0a0b0cff')
  })
})

describe('decodeGPacket', () => {
  it('reads Cortex-M PC from a g blob', () => {
    const regs = new Uint8Array(17 * 4)
    // PC = r15 at offset 15*4 → 0x00001234 little-endian
    regs[15 * 4] = 0x34
    regs[15 * 4 + 1] = 0x12
    const hex = bytesToHex(regs)
    const view = decodeGPacket('arm', hex)
    expect(view.pc).toBe('00001234')
    expect(view.summary).toBe('PC 00001234')
    expect(view.dump).toContain('R15=00001234')
  })

  it('reads AArch64 PC from a g blob', () => {
    const regs = new Uint8Array(34 * 8)
    const pcOff = 33 * 8
    // PC = 0x0000000040081234 LE
    regs[pcOff] = 0x34
    regs[pcOff + 1] = 0x12
    regs[pcOff + 2] = 0x08
    regs[pcOff + 3] = 0x40
    const view = decodeGPacket('aarch64', bytesToHex(regs))
    expect(view.pc).toBe('0000000040081234')
    expect(view.dump).toContain('PC=0000000040081234')
  })
})

describe('archFromBoard', () => {
  it('maps boards.ts arch strings', async () => {
    const { archFromBoard } = await import('@/debug/gdb/regs')
    expect(archFromBoard('ARMv7-M')).toBe('arm')
    expect(archFromBoard('ARMv8-A')).toBe('aarch64')
    expect(archFromBoard('RV32IMAFDC')).toBe('riscv32')
  })
})
