/**
 * MCP4725 unit tests — fast-write decode, RDY read, DacChip history.
 */

import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { dacCodeToVolts, isDacChip } from '../dac/model'
import { createMcp4725, isMcp4725 } from './mcp4725'

describe('MCP4725', () => {
  it('exposes a DacChip + JSON register map', () => {
    const chip = createMcp4725()
    expect(isDacChip(chip)).toBe(true)
    expect(isMcp4725(chip)).toBe(true)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.address).toBe(0x61)
    expect(chip.decl.channelCount).toBe(1)
    expect(chip.decl.resolutionBits).toBe(12)
    expect(chip.registers.some((r) => r.name === 'DAC_CODE')).toBe(true)
  })

  it('decodes Zephyr fast-write frames into code + volts', () => {
    const chip = createMcp4725()
    // code 0xA5A = 2650: hi nibble 0xA, lo 0x5A
    chip.write?.(new Uint8Array([0x0a, 0x5a]))
    expect(chip.getCode()).toBe(0x0a5a)
    const ch = chip.getChannel(0)
    expect(ch.code).toBe(0x0a5a)
    expect(ch.volts).toBeCloseTo(dacCodeToVolts(0x0a5a, chip.decl), 5)
    expect(ch.powerDown).toBe('normal')
  })

  it('returns RDY on read so driver init succeeds', () => {
    const chip = createMcp4725()
    const bytes = chip.read?.(5) ?? new Uint8Array()
    expect(bytes.length).toBe(5)
    expect(bytes[0]! & 0x80).toBe(0x80)
  })

  it('appends history on each code change', () => {
    const chip = createMcp4725()
    chip.write?.(new Uint8Array([0x00, 0x00]))
    chip.write?.(new Uint8Array([0x08, 0x00]))
    chip.write?.(new Uint8Array([0x0f, 0xff]))
    const hist = chip.getHistory(0)
    expect(hist.length).toBeGreaterThanOrEqual(3)
    expect(hist[hist.length - 1]!.code).toBe(0x0fff)
  })

  it('poke DAC_CODE updates Vout', () => {
    const chip = createMcp4725()
    chip.poke(0x00, 2048)
    expect(chip.getCode()).toBe(2048)
    expect(chip.getChannel(0).volts).toBeCloseTo(1.65, 2)
  })

  it('records power-down bits from fast-write', () => {
    const chip = createMcp4725()
    // PD=01 (1k), code 0
    chip.write?.(new Uint8Array([0x10, 0x00]))
    expect(chip.getChannel(0).powerDown).toBe('1k')
  })
})
