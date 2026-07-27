import { describe, expect, it } from 'vitest'
import { parseRegisters } from '@/debug/parseRegisters'

describe('parseRegisters', () => {
  it('reads R15 as PC on Cortex-M dumps', () => {
    const dump = [
      'R00=00000000 R01=20001000 R02=00000000 R03=00000000',
      'R04=00000000 R05=00000000 R06=00000000 R07=00000000',
      'R08=00000000 R09=00000000 R10=00000000 R11=00000000',
      'R12=00000000 R13=20004000 R14=00000401 R15=00001234',
      'XPSR=61000000 -Z-- T M0 handler',
    ].join('\n')
    expect(parseRegisters(dump)).toEqual({ pc: '00001234', summary: 'PC 00001234' })
  })

  it('reads PC= on AArch64 dumps', () => {
    const dump = 'PC=0000000040081234 X00=0000000000000001 X01=0000000000000000'
    expect(parseRegisters(dump)).toEqual({
      pc: '0000000040081234',
      summary: 'PC 0000000040081234',
    })
  })

  it('reads lowercase pc on RISC-V dumps', () => {
    const dump = ['pc       80001234', 'ra       80000400', 'sp       80800000'].join('\n')
    expect(parseRegisters(dump)).toEqual({ pc: '80001234', summary: 'PC 80001234' })
  })

  it('returns nulls when nothing matches', () => {
    expect(parseRegisters('no cpu here')).toEqual({ pc: null, summary: null })
  })
})
