/** Bus-agnostic RTC surface the dock renders. */

import type { I2cChip } from '../i2c'
import type { FieldDecl, RegisterDecl } from '../registers/types'

export interface RtcDateTime {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
  second: number
}

export type RtcAlarmField = 'minute' | 'hour' | 'day' | 'weekday'

export interface RtcAlarm {
  id: number
  armed: boolean
  minute?: number
  hour?: number
  day?: number
  weekday?: number
  pending: boolean
}

export interface RtcDecl {
  name: string
  shellLabel?: string
  defaultAddress: number
  alarmsCount: number
  /** Compare fields this part can arm; PCF8523 maps to Zephyr mask 0x4e. */
  alarmFields: readonly RtcAlarmField[]
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export const RTC_ALARM_MASK = {
  minute: 0x02,
  hour: 0x04,
  day: 0x08,
  weekday: 0x40,
} as const satisfies Record<RtcAlarmField, number>

export interface RtcChip extends I2cChip {
  write(bytes: Uint8Array): boolean
  read(length: number): Uint8Array
  readonly decl: RtcDecl
  readonly registers: readonly RegisterDecl[]
  getTime(): RtcDateTime
  setTime(time: RtcDateTime): void
  syncFromBrowser(): void
  getAlarms(): RtcAlarm[]
  setAlarm(
    id: number,
    fields: { minute?: number; hour?: number; day?: number; weekday?: number },
  ): void
  clearAlarm(id: number): void
  clearPending(id: number): void
  oscillatorStopped(): boolean
  peek(addr: number): number
  getPointer(): number
  poke(addr: number, value: number): void
  setField(addr: number, field: Pick<FieldDecl, 'lsb' | 'msb'>, value: number): void
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

export function alarmMask(alarm: Pick<RtcAlarm, RtcAlarmField>): number {
  let mask = 0
  if (alarm.minute !== undefined) mask |= RTC_ALARM_MASK.minute
  if (alarm.hour !== undefined) mask |= RTC_ALARM_MASK.hour
  if (alarm.day !== undefined) mask |= RTC_ALARM_MASK.day
  if (alarm.weekday !== undefined) mask |= RTC_ALARM_MASK.weekday
  return mask
}

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
