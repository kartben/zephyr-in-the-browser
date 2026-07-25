/**
 * PCA9685 unit tests — PRE_SCALE math, set_cycles byte patterns, PwmChip view.
 */

import { describe, expect, it } from 'vitest'
import { hasRegisterMap } from '../registers/types'
import { isPwmChip } from '../pwm/model'
import { createPca9685, isPca9685 } from './pca9685'

describe('PCA9685', () => {
  it('exposes a PwmChip + JSON register map', () => {
    const chip = createPca9685()
    expect(isPwmChip(chip)).toBe(true)
    expect(isPca9685(chip)).toBe(true)
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.address).toBe(0x60)
    expect(chip.decl.channelCount).toBe(16)
    expect(chip.decl.periodScope).toBe('controller')
    expect(chip.registers.some((r) => r.name === 'PRE_SCALE')).toBe(true)
  })

  it('starts with channels full-off and default PRE_SCALE', () => {
    const chip = createPca9685()
    expect(chip.getPreScale()).toBe(0x1e)
    expect(chip.getFrequencyHz()).toBeCloseTo(25e6 / (4096 * 0x1f), 5)
    const ch = chip.getChannel(0)
    expect(ch.fullOff).toBe(true)
    expect(ch.duty).toBe(0)
  })

  it('handles Zephyr set_cycles: MODE1 AI, then LEDn burst', () => {
    const chip = createPca9685()
    // Init: AUTO_INC
    chip.write?.(new Uint8Array([0x00, 0x20]))
    // Channel 0: ON=0, OFF=1434 (≈35% of 4096)
    chip.write?.(new Uint8Array([0x06, 0x00, 0x00, 0x9a, 0x05]))
    const ch = chip.getChannel(0)
    expect(ch.fullOn).toBe(false)
    expect(ch.fullOff).toBe(false)
    expect(ch.duty).toBeCloseTo(1434 / 4096, 5)
    expect(chip.peek?.(0x06)).toBe(0x00)
    expect(chip.peek?.(0x09)).toBe(0x05)
  })

  it('programs PRE_SCALE only while SLEEP is set', () => {
    const chip = createPca9685()
    chip.write?.(new Uint8Array([0x00, 0x20])) // AI, awake
    chip.write?.(new Uint8Array([0xfe, 0x7a]))
    expect(chip.getPreScale()).toBe(0x1e) // unchanged
    chip.write?.(new Uint8Array([0x00, 0x30])) // AI|SLEEP
    chip.write?.(new Uint8Array([0xfe, 0x7a]))
    expect(chip.getPreScale()).toBe(0x7a)
    const period = chip.getChannel(0).periodNs
    expect(period).toBeCloseTo((1e9 * 4096 * 0x7b) / 25e6, -2)
  })

  it('full-on and full-off flags project correctly', () => {
    const chip = createPca9685()
    chip.write?.(new Uint8Array([0x06, 0x00, 0x10, 0x00, 0x00])) // full-on
    expect(chip.getChannel(0).fullOn).toBe(true)
    expect(chip.getChannel(0).duty).toBe(1)
    chip.write?.(new Uint8Array([0x06, 0x00, 0x00, 0x00, 0x10])) // full-off
    expect(chip.getChannel(0).fullOff).toBe(true)
    expect(chip.getChannel(0).duty).toBe(0)
  })

  it('poke PRE_SCALE updates period for every channel', () => {
    const chip = createPca9685()
    chip.poke?.(0xfe, 0x7a)
    expect(chip.getDetail?.('prescale')).toBe('0x7A')
    expect(chip.getDetail?.('drive')).toBe('totem-pole')
    const a = chip.getChannel(0).periodNs
    const b = chip.getChannel(15).periodNs
    expect(a).toBe(b)
  })
})
