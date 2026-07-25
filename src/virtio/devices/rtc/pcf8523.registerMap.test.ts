import { describe, expect, it } from 'vitest'

import { createPcf8523 } from './pcf8523'
import { hasRegisterMap } from '../registers/types'

describe('PCF8523 register map', () => {
  it('exposes a named SVD-style map the shared inspector can open', () => {
    const chip = createPcf8523({
      time: { year: 2026, month: 7, day: 25, weekday: 6, hour: 10, minute: 30, second: 0 },
    })
    expect(hasRegisterMap(chip)).toBe(true)
    expect(chip.registers.find((r) => r.addr === 0x00)?.name).toBe('Control_1')
    expect(chip.registers.find((r) => r.addr === 0x0a)?.name).toBe('Minute_alarm')

    // Live BCD minutes after seed.
    expect(chip.peek(0x04) & 0x7f).toBe(0x30) // BCD 30
    chip.setField(0x00, { lsb: 5, msb: 5 }, 1) // STOP
    expect(chip.peek(0x00) & 0x20).toBe(0x20)

    // Alarm AEN clear + minute compare via poke, mirrors setAlarm.
    chip.poke(0x0a, 0x15) // armed, minute 15 BCD-ish raw
    expect(chip.peek(0x0a) & 0x80).toBe(0)
    chip.setField(0x0a, { lsb: 7, msb: 7 }, 1) // disable
    expect(chip.peek(0x0a) & 0x80).toBe(0x80)
  })

  it('clears AF through Control_2 setField the way a driver would', () => {
    const chip = createPcf8523({
      time: { year: 2026, month: 7, day: 25, weekday: 6, hour: 9, minute: 0, second: 0 },
    })
    chip.setAlarm(0, { minute: 0, hour: 9 })
    // Already matching — AF should set.
    expect(chip.getAlarms()[0]?.pending).toBe(true)
    chip.setField(0x01, { lsb: 3, msb: 3 }, 0) // clear AF (AND semantics)
    expect(chip.getAlarms()[0]?.pending).toBe(false)
  })
})
