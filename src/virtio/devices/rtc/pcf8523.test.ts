/**
 * Unit tests for the PCF8523 model: BCD round-trips the Zephyr driver expects,
 * alarm AEN semantics, and AF sticky flag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPcf8523 } from './pcf8523'

const REG_CONTROL_1 = 0x00
const REG_CONTROL_2 = 0x01
const REG_SECONDS = 0x03
const REG_MINUTE_ALARM = 0x0a

function writeRegs(chip: ReturnType<typeof createPcf8523>, addr: number, ...data: number[]) {
  chip.write(Uint8Array.of(addr, ...data))
}

function readRegs(chip: ReturnType<typeof createPcf8523>, addr: number, len: number) {
  chip.write(Uint8Array.of(addr))
  return chip.read(len)
}

describe('PCF8523', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-25T08:30:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds from the browser clock with OS clear so get_time would succeed', () => {
    const chip = createPcf8523()
    expect(chip.oscillatorStopped()).toBe(false)
    const t = chip.getTime()
    expect(t).toMatchObject({
      year: 2026,
      month: 7,
      day: 25,
      hour: 8,
      minute: 30,
      second: 0,
    })
  })

  it('round-trips BCD time the way the Zephyr driver writes it', () => {
    const chip = createPcf8523()
    // Mimic pcf8523_set_time: STOP, then SECONDS..YEARS, then clear STOP.
    writeRegs(chip, REG_CONTROL_1, 0x20)
    writeRegs(
      chip,
      REG_SECONDS,
      0x45, // 45s
      0x19, // 19m
      0x04, // 04h
      0x17, // 17th
      0x06, // Saturday
      0x11, // November
      0x24, // 2024
    )
    writeRegs(chip, REG_CONTROL_1, 0x00)

    const regs = readRegs(chip, REG_SECONDS, 7)
    expect(regs[0] & 0x7f).toBe(0x45)
    expect(regs[0] & 0x80).toBe(0) // OS clear
    expect([...regs.slice(1)]).toEqual([0x19, 0x04, 0x17, 0x06, 0x11, 0x24])

    expect(chip.getTime()).toMatchObject({
      year: 2024,
      month: 11,
      day: 17,
      weekday: 6,
      hour: 4,
      minute: 19,
      second: 45,
    })
  })

  it('advances while STOP is clear', () => {
    const chip = createPcf8523()
    vi.advanceTimersByTime(3500)
    expect(chip.getTime().second).toBe(3)
  })

  it('freezes while STOP is set', () => {
    const chip = createPcf8523()
    writeRegs(chip, REG_CONTROL_1, 0x20)
    vi.advanceTimersByTime(5000)
    expect(chip.getTime().second).toBe(0)
  })

  it('arms alarms with AEN-clear fields and reports them on getAlarms', () => {
    const chip = createPcf8523()
    // Zephyr rtc_alarm_set_time with minute+hour mask: AEN clear on those,
    // AEN set on day/weekday.
    writeRegs(chip, REG_MINUTE_ALARM, 0x35, 0x09, 0x80, 0x80)

    const [alarm] = chip.getAlarms()
    expect(alarm).toMatchObject({
      armed: true,
      minute: 35,
      hour: 9,
      pending: false,
    })
    expect(alarm?.day).toBeUndefined()
    expect(alarm?.weekday).toBeUndefined()
  })

  it('sets AF when the armed fields match wall time', () => {
    const chip = createPcf8523()
    chip.setTime({
      year: 2026,
      month: 7,
      day: 25,
      weekday: 6,
      hour: 8,
      minute: 30,
      second: 0,
    })
    // Arm minute+hour for 08:31
    chip.setAlarm(0, { minute: 31, hour: 8 })
    expect(chip.getAlarms()[0]?.pending).toBe(false)

    vi.advanceTimersByTime(60_000)
    expect(chip.getTime().minute).toBe(31)
    expect(chip.getAlarms()[0]?.pending).toBe(true)

    // AF clears on write-0 (AND semantics), stays on write-1
    writeRegs(chip, REG_CONTROL_2, 0xff)
    expect(readRegs(chip, REG_CONTROL_2, 1)[0]! & 0x08).toBe(0x08)
    writeRegs(chip, REG_CONTROL_2, 0xf7) // AF bit 0
    expect(readRegs(chip, REG_CONTROL_2, 1)[0]! & 0x08).toBe(0)
  })

  it('syncFromBrowser refreshes from Date', () => {
    const chip = createPcf8523()
    chip.setTime({
      year: 2001,
      month: 1,
      day: 1,
      weekday: 1,
      hour: 0,
      minute: 0,
      second: 0,
    })
    chip.syncFromBrowser()
    expect(chip.getTime()).toMatchObject({ year: 2026, month: 7, day: 25, hour: 8, minute: 30 })
  })

  it('page setAlarm / clearAlarm match the register view', () => {
    const chip = createPcf8523()
    chip.setAlarm(0, { minute: 15, hour: 14, day: 25 })
    expect([...readRegs(chip, REG_MINUTE_ALARM, 4)]).toEqual([0x15, 0x14, 0x25, 0x80])
    chip.clearAlarm(0)
    expect([...readRegs(chip, REG_MINUTE_ALARM, 4)]).toEqual([0x80, 0x80, 0x80, 0x80])
    expect(chip.getAlarms()[0]?.armed).toBe(false)
  })

  it('matches day-of-month and weekday compares', () => {
    const chip = createPcf8523()
    // Saturday 25th at 08:30 — arm weekday=Sat + day=25 + hour=9
    chip.setAlarm(0, { weekday: 6, day: 25, hour: 9 })
    expect(chip.getAlarms()[0]).toMatchObject({
      armed: true,
      weekday: 6,
      day: 25,
      hour: 9,
      pending: false,
    })
    expect(chip.getAlarms()[0]?.minute).toBeUndefined()

    vi.advanceTimersByTime(30 * 60_000) // → 09:00
    expect(chip.getTime()).toMatchObject({ hour: 9, minute: 0, day: 25, weekday: 6 })
    expect(chip.getAlarms()[0]?.pending).toBe(true)
  })

  it('declares the four PCF8523 alarm fields', () => {
    const chip = createPcf8523()
    expect(chip.decl.alarmFields).toEqual(['minute', 'hour', 'day', 'weekday'])
  })
})
