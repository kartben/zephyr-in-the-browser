import { describe, expect, it } from 'vitest'
import { organizeRegisters } from '@/debug/registerModel'

describe('organizeRegisters', () => {
  it('splits Cortex-M dump into featured / general / status', () => {
    const dump = [
      'R00=00000001 R01=20001000 R02=00000000 R03=00000000',
      'R04=00000000 R05=00000000 R06=00000000 R07=00000000',
      'R08=00000000 R09=00000000 R10=00000000 R11=00000000',
      'R12=00000000 R13=20004000 R14=00000401 R15=00001234',
      'XPSR=61000000 -Z-- T M0 handler',
    ].join('\n')
    const layout = organizeRegisters(dump)
    expect(layout.pc).toBe('00001234')
    expect(layout.featured).toEqual([
      { name: 'PC', value: '00001234' },
      { name: 'SP', value: '20004000' },
      { name: 'LR', value: '00000401' },
    ])
    expect(layout.general[0]).toEqual({ name: 'R00', value: '00000001' })
    expect(layout.general.some((r) => r.name === 'R15')).toBe(false)
    expect(layout.status).toEqual([{ name: 'XPSR', value: '61000000' }])
  })

  it('handles AArch64 PC= / Xnn= lines', () => {
    const dump = 'PC=0000000040081234 X00=0000000000000001 X01=0000000000000000 SP=0000000080000000'
    const layout = organizeRegisters(dump)
    expect(layout.featured.map((r) => r.name)).toEqual(['PC', 'SP'])
    expect(layout.general).toHaveLength(2)
  })

  it('handles RISC-V whitespace pairs', () => {
    const dump = ['pc       80001234', 'ra       80000400', 'sp       80800000', 'gp       80010000'].join(
      '\n',
    )
    const layout = organizeRegisters(dump)
    expect(layout.featured).toEqual([
      { name: 'PC', value: '80001234' },
      { name: 'SP', value: '80800000' },
      { name: 'RA', value: '80000400' },
    ])
    expect(layout.general).toEqual([{ name: 'GP', value: '80010000' }])
  })

  it('returns empty for blank input', () => {
    expect(organizeRegisters(null).general).toEqual([])
    expect(organizeRegisters('').featured).toEqual([])
  })
})
