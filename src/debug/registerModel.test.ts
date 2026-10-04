import { describe, expect, it } from 'vitest'
import { organizeRegisters, registerValues } from '@/debug/registerModel'

describe('registerValues: $arg0..$arg3', () => {
  const args = (dump: string) => [0, 1, 2, 3].map((i) => registerValues(dump).get(`arg${i}`))

  it('reads the first four argument registers of each ABI', () => {
    expect(args('X00=0000000000000010 X01=0000000000000004 X02=00000000000a0000 X03=0000000000000000')).toEqual(
      [0x10, 4, 0xa0000, 0],
    )
    expect(args('R00=00000010 R01=00000004 R02=000a0000 R03=00000000')).toEqual([0x10, 4, 0xa0000, 0])
    expect(args('a0=80006894 a1=00000004 a2=000a0000 a3=00000000')).toEqual([0x80006894, 4, 0xa0000, 0])
  })

  it('starts at a2 on Xtensa, past the return address and stack pointer', () => {
    // As src/debug/gdb/regs.ts decodes a stop in gpio_esp32_config(dev, 2, flags).
    const dump = [
      'pc=40081767',
      'a00=800d1234 a01=3ffb1e40 a02=3f400df8 a03=00000002 a04=000a0000 a05=00000000',
      'a06=00000000 a07=00000000 a08=00000000 a09=00000000 a10=00000000 a11=00000000',
      'a12=00000000 a13=00000000 a14=00000000 a15=00000000',
      'ps=00060120 windowbase=00000002 windowstart=00000005',
    ].join('\n')
    expect(args(dump)).toEqual([0x3f400df8, 2, 0xa0000, 0])
  })
})

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
