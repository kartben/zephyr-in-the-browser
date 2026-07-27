import { describe, expect, it } from 'vitest'
import {
  functionNameFromLabel,
  inferArchFromDump,
  regRole,
  regTooltip,
} from '@/debug/regHints'

describe('regHints', () => {
  it('infers arch from dump', () => {
    expect(inferArchFromDump('X00=1\nPSTATE=c5')).toBe('aarch64')
    expect(inferArchFromDump('R00=1\nXPSR=61000000')).toBe('arm')
    expect(inferArchFromDump('a0=1\nra=8000')).toBe('riscv32')
  })

  it('strips offset from pcLabel', () => {
    expect(functionNameFromLabel('shell_process+0x14')).toBe('shell_process')
    expect(functionNameFromLabel('main')).toBe('main')
  })

  it('maps AArch64 args to DWARF formals', () => {
    const ctx = {
      arch: 'aarch64' as const,
      functionName: 'open',
      formals: ['pathname', 'flags'],
    }
    expect(regRole('X00', ctx)).toBe('pathname · arg0 / return')
    expect(regRole('X01', ctx)).toBe('flags · arg1')
    expect(regRole('X02', ctx)).toBe('arg2')
    expect(regRole('X19', ctx)).toBe('callee-saved')
    expect(regRole('X29', ctx)).toBe('frame pointer')
  })

  it('builds multi-line tooltips', () => {
    const tip = regTooltip(
      'X00',
      '0000000040001000',
      { arch: 'aarch64', functionName: 'open', formals: ['pathname'] },
      { canPeek: true },
    )
    expect(tip).toContain('0x0000000040001000')
    expect(tip).toContain('pathname')
    expect(tip).toContain('in open')
    expect(tip).toContain('Click to peek memory')
  })
})
