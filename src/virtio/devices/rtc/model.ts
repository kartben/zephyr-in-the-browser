/**
 * Bus-agnostic RTC surface the dock renders.
 *
 * An RTC is datetime + alarms, not sensor channels and not a hex dump. The
 * first provider is an I²C PCF8523, but {@link RtcChip} deliberately does not
 * mention I²C: a SPI part, an SoC RTC, or `zephyr,rtc-emul` could implement the
 * same handle and reuse {@link RtcBody} unchanged.
 */

import type { I2cChip } from '../i2c'

/** Broken-down wall time the card and guest drivers share. */
export interface RtcDateTime {
  year: number // full year, e.g. 2026
  month: number // 1–12
  day: number // 1–31
  weekday: number // 0=Sunday … 6=Saturday
  hour: number // 0–23
  minute: number // 0–59
  second: number // 0–59
}

/** Compare fields Zephyr's RTC alarm mask can enable. */
export type RtcAlarmField = 'minute' | 'hour' | 'day' | 'weekday'

/** One hardware alarm, as the dock wants to show it. */
export interface RtcAlarm {
  /** Alarm index (PCF8523 has one). */
  id: number
  /** True when at least one compare field is armed. */
  armed: boolean
  /** Fields that participate in the match (AEN clear on PCF8523). */
  minute?: number
  hour?: number
  /** Day of month 1–31. */
  day?: number
  /** Day of week 0=Sunday … 6=Saturday. */
  weekday?: number
  /** Sticky alarm-fired flag (AF), until cleared. */
  pending: boolean
}

export interface RtcDecl {
  name: string
  /** Device name for shell hints (`pcf8523@68`). */
  shellLabel?: string
  defaultAddress: number
  /** How many hardware alarms the part exposes. */
  alarmsCount: number
  /**
   * Compare fields this part can arm. The dock renders only these — so a
   * simpler RTC that only does hour+minute does not grow empty day/weekday
   * rows. PCF8523: minute, hour, day, weekday (Zephyr mask 0x4e).
   */
  alarmFields: readonly RtcAlarmField[]
}

/** Sunday-first labels matching `RtcDateTime.weekday` / Zephyr `tm_wday`. */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Zephyr RTC_ALARM_TIME_MASK bits for the fields PCF8523 supports. */
export const RTC_ALARM_MASK = {
  minute: 0x02,
  hour: 0x04,
  day: 0x08,
  weekday: 0x40,
} as const satisfies Record<RtcAlarmField, number>

/**
 * What every RTC provider must expose to the dock. Extends {@link I2cChip} only
 * because today's providers ride the virtio-i2c bus — the RTC-shaped methods
 * are what {@link isRtcChip} and the card care about.
 */
export interface RtcChip extends I2cChip {
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: RtcDecl
  /** Live wall time, advancing while the oscillator runs. */
  getTime(): RtcDateTime
  /** Program the clock (also clears the oscillator-stop flag). */
  setTime(time: RtcDateTime): void
  /** Copy the browser's local wall clock into the chip. */
  syncFromBrowser(): void
  /** Hardware alarms, for the card's armed / fired readout. */
  getAlarms(): RtcAlarm[]
  /**
   * Arm alarm `id` from the page. `fields` lists which compares to enable;
   * omit a field (or pass an empty object with armed=false via clearAlarm)
   * to leave it disabled. Matching the Zephyr mask: enabled fields compare.
   */
  setAlarm(
    id: number,
    fields: { minute?: number; hour?: number; day?: number; weekday?: number },
  ): void
  /** Disarm every compare field on alarm `id` and clear pending. */
  clearAlarm(id: number): void
  /** Clear the sticky fired flag without touching the compare registers. */
  clearPending(id: number): void
  /** True while the oscillator-stop / integrity flag would make get_time fail. */
  oscillatorStopped(): boolean
  subscribe(fn: () => void): () => void
}

export function isRtcChip(chip: I2cChip): chip is RtcChip {
  return 'decl' in chip && 'getTime' in chip && 'syncFromBrowser' in chip && 'getAlarms' in chip
}

export function formatRtcTime(t: RtcDateTime): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const wday = WEEKDAY_SHORT[t.weekday] ?? `w${t.weekday}`
  return `${wday} ${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`
}

export function formatAlarm(alarm: RtcAlarm): string {
  if (!alarm.armed) return 'off'
  const pad = (n: number) => n.toString().padStart(2, '0')
  const parts: string[] = []
  if (alarm.weekday !== undefined) {
    parts.push(WEEKDAY_SHORT[alarm.weekday] ?? `wday ${alarm.weekday}`)
  }
  if (alarm.day !== undefined) parts.push(`day ${alarm.day}`)
  if (alarm.hour !== undefined || alarm.minute !== undefined) {
    parts.push(`${pad(alarm.hour ?? 0)}:${pad(alarm.minute ?? 0)}`)
  } else if (parts.length === 0) {
    return 'armed'
  }
  return parts.join(' · ')
}

/** Zephyr alarm mask for the enabled fields on an {@link RtcAlarm}. */
export function alarmMask(alarm: Pick<RtcAlarm, RtcAlarmField>): number {
  let mask = 0
  if (alarm.minute !== undefined) mask |= RTC_ALARM_MASK.minute
  if (alarm.hour !== undefined) mask |= RTC_ALARM_MASK.hour
  if (alarm.day !== undefined) mask |= RTC_ALARM_MASK.day
  if (alarm.weekday !== undefined) mask |= RTC_ALARM_MASK.weekday
  return mask
}

/** Browser local time as an {@link RtcDateTime}. */
export function browserNow(): RtcDateTime {
  const d = new Date()
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    weekday: d.getDay(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  }
}
