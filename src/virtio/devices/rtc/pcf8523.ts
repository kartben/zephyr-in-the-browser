/**
 * An NXP PCF8523 RTC, as an {@link RtcChip}.
 *
 * Register map and semantics match Zephyr's stock `nxp,pcf8523` driver
 * (`drivers/rtc/rtc_pcf8523.c`): BCD time at 0x03–0x09, alarm compares at
 * 0x0a–0x0d with AEN=1 meaning *disabled*, AF sticky in Control_2, and
 * get_time refusing to return while the OS (oscillator stop) bit is set.
 *
 * Timekeeping advances against the browser wall clock while STOP is clear.
 * Alarm matches set AF; the dock shows that as "fired" without needing INT1
 * GPIO (callback support still wants int1-gpios on the guest side).
 */

import {
  browserNow,
  type RtcAlarm,
  type RtcChip,
  type RtcDateTime,
  type RtcDecl,
} from './model'

const REG_CONTROL_1 = 0x00
const REG_CONTROL_2 = 0x01
const REG_SECONDS = 0x03
const REG_MINUTES = 0x04
const REG_HOURS = 0x05
const REG_DAYS = 0x06
const REG_WEEKDAYS = 0x07
const REG_MONTHS = 0x08
const REG_YEARS = 0x09
const REG_MINUTE_ALARM = 0x0a
const REG_HOUR_ALARM = 0x0b
const REG_DAY_ALARM = 0x0c
const REG_WEEKDAY_ALARM = 0x0d
const REG_TMR_CLKOUT = 0x0f
const REG_COUNT = 0x14

const CONTROL_1_STOP = 0x20
const CONTROL_2_AF = 0x08
const CONTROL_2_SF = 0x10
const CONTROL_2_CTAF = 0x40
const CONTROL_2_CTBF = 0x20
const CONTROL_2_WTAF = 0x80
/** Flag bits that clear on write-0 (PCF8523 AND semantics). */
const CONTROL_2_FLAGS = CONTROL_2_AF | CONTROL_2_SF | CONTROL_2_CTAF | CONTROL_2_CTBF | CONTROL_2_WTAF

const SECONDS_OS = 0x80
const AEN = 0x80

export const pcf8523Decl: RtcDecl = {
  name: 'PCF8523 RTC',
  shellLabel: 'pcf8523@68',
  defaultAddress: 0x68,
  alarmsCount: 1,
  // Zephyr PCF8523_RTC_ALARM_TIME_MASK = minute|hour|monthday|weekday (0x4e).
  alarmFields: ['minute', 'hour', 'day', 'weekday'],
}

export interface Pcf8523Options {
  address?: number
  name?: string
  /** Seed time; defaults to the browser wall clock with OS cleared. */
  time?: RtcDateTime
}

function bin2bcd(value: number): number {
  const v = Math.max(0, Math.min(99, Math.trunc(value)))
  return ((v / 10) << 4) | (v % 10)
}

function bcd2bin(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f)
}

function clampTime(t: RtcDateTime): RtcDateTime {
  return {
    year: Math.min(2099, Math.max(2000, Math.trunc(t.year))),
    month: Math.min(12, Math.max(1, Math.trunc(t.month))),
    day: Math.min(31, Math.max(1, Math.trunc(t.day))),
    weekday: Math.min(6, Math.max(0, Math.trunc(t.weekday))),
    hour: Math.min(23, Math.max(0, Math.trunc(t.hour))),
    minute: Math.min(59, Math.max(0, Math.trunc(t.minute))),
    second: Math.min(59, Math.max(0, Math.trunc(t.second))),
  }
}

/** Encode a civil time as epoch-ms in *local* timezone (matches browserNow). */
function toLocalMs(t: RtcDateTime): number {
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second).getTime()
}

function fromLocalMs(ms: number): RtcDateTime {
  const d = new Date(ms)
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

export function createPcf8523({ address, name, time }: Pcf8523Options = {}): RtcChip {
  const regs = new Uint8Array(REG_COUNT)
  // Power-on-ish defaults: alarms disabled (AEN set), oscillator running after seed.
  regs[REG_MINUTE_ALARM] = AEN
  regs[REG_HOUR_ALARM] = AEN
  regs[REG_DAY_ALARM] = AEN
  regs[REG_WEEKDAY_ALARM] = AEN
  regs[REG_TMR_CLKOUT] = 0x38 // COF = 32768 Hz reset value-ish

  let pointer = 0
  /** Chip time corresponding to `anchorMs`. */
  let anchorTime = clampTime(time ?? browserNow())
  /** performance.now() (or Date) when `anchorTime` was latched. */
  let anchorMs = Date.now()

  const listeners = new Set<() => void>()
  const notify = () => {
    for (const fn of listeners) fn()
  }

  const stopped = () => (regs[REG_CONTROL_1]! & CONTROL_1_STOP) !== 0

  const writeTimeRegs = (t: RtcDateTime) => {
    const c = clampTime(t)
    regs[REG_SECONDS] = bin2bcd(c.second) // OS cleared
    regs[REG_MINUTES] = bin2bcd(c.minute)
    regs[REG_HOURS] = bin2bcd(c.hour)
    regs[REG_DAYS] = bin2bcd(c.day)
    regs[REG_WEEKDAYS] = bin2bcd(c.weekday)
    regs[REG_MONTHS] = bin2bcd(c.month)
    regs[REG_YEARS] = bin2bcd(c.year - 2000)
  }

  const readTimeRegs = (): RtcDateTime => ({
    year: bcd2bin(regs[REG_YEARS]!) + 2000,
    month: Math.max(1, bcd2bin(regs[REG_MONTHS]! & 0x1f)),
    day: Math.max(1, bcd2bin(regs[REG_DAYS]! & 0x3f)),
    weekday: bcd2bin(regs[REG_WEEKDAYS]! & 0x07),
    hour: bcd2bin(regs[REG_HOURS]! & 0x3f),
    minute: bcd2bin(regs[REG_MINUTES]! & 0x7f),
    second: bcd2bin(regs[REG_SECONDS]! & 0x7f),
  })

  /** Advance from the anchor when the oscillator is running. */
  const syncAdvance = () => {
    if (stopped()) return
    const now = Date.now()
    const elapsed = Math.max(0, Math.floor((now - anchorMs) / 1000))
    if (elapsed === 0) return
    const next = fromLocalMs(toLocalMs(anchorTime) + elapsed * 1000)
    anchorTime = next
    anchorMs = now
    writeTimeRegs(next)
    evaluateAlarm()
  }

  const latchFromRegs = () => {
    anchorTime = readTimeRegs()
    anchorMs = Date.now()
  }

  const alarmField = (
    reg: number,
  ): { enabled: boolean; value: number } => {
    const raw = regs[reg]!
    return { enabled: (raw & AEN) === 0, value: bcd2bin(raw & ~AEN) }
  }

  const evaluateAlarm = () => {
    const min = alarmField(REG_MINUTE_ALARM)
    const hour = alarmField(REG_HOUR_ALARM)
    const day = alarmField(REG_DAY_ALARM)
    const wday = alarmField(REG_WEEKDAY_ALARM)
    if (!min.enabled && !hour.enabled && !day.enabled && !wday.enabled) return

    const t = readTimeRegs()
    if (min.enabled && min.value !== t.minute) return
    if (hour.enabled && hour.value !== t.hour) return
    if (day.enabled && day.value !== t.day) return
    if (wday.enabled && wday.value !== t.weekday) return

    if ((regs[REG_CONTROL_2]! & CONTROL_2_AF) === 0) {
      regs[REG_CONTROL_2]! |= CONTROL_2_AF
      notify()
    }
  }

  writeTimeRegs(anchorTime)

  // Tick once a second so the dock clock moves without guest traffic.
  let tickTimer: ReturnType<typeof setInterval> | undefined
  const ensureTick = () => {
    if (tickTimer !== undefined) return
    tickTimer = setInterval(() => {
      if (listeners.size === 0) return
      const before = regs[REG_SECONDS]
      syncAdvance()
      if (regs[REG_SECONDS] !== before) notify()
    }, 250)
  }

  const writeReg = (addr: number, value: number) => {
    if (addr < 0 || addr >= REG_COUNT) return
    if (addr === REG_CONTROL_2) {
      // Flag bits clear on 0, stay on 1 (AND). Other bits take the written value.
      const prev = regs[REG_CONTROL_2]!
      const flags = prev & CONTROL_2_FLAGS & value
      const rest = value & ~CONTROL_2_FLAGS
      regs[REG_CONTROL_2] = flags | rest
      return
    }
    regs[addr] = value & 0xff
    if (addr >= REG_SECONDS && addr <= REG_YEARS) {
      // Guest (or card) programmed the clock — OS goes clear on SECONDS writes
      // that omit the bit; latch the new civil time as the run base.
      if (addr === REG_SECONDS) regs[REG_SECONDS]! &= ~SECONDS_OS
      latchFromRegs()
    }
    if (addr >= REG_MINUTE_ALARM && addr <= REG_WEEKDAY_ALARM) {
      evaluateAlarm()
    }
  }

  const chip: RtcChip = {
    address: address ?? pcf8523Decl.defaultAddress,
    name: name ?? pcf8523Decl.name,
    decl: pcf8523Decl,

    write(bytes) {
      if (bytes.length === 0) return true
      syncAdvance()
      pointer = bytes[0]! % REG_COUNT
      for (let i = 1; i < bytes.length; i++) {
        writeReg(pointer, bytes[i]!)
        pointer = (pointer + 1) % REG_COUNT
      }
      notify()
      return true
    },

    read(length) {
      syncAdvance()
      const out = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        out[i] = regs[pointer]!
        // OS is sticky in the register until a time set clears it; reads return
        // the live BCD with whatever OS state we hold.
        pointer = (pointer + 1) % REG_COUNT
      }
      notify()
      return out
    },

    getTime() {
      syncAdvance()
      return readTimeRegs()
    },

    setTime(t) {
      const c = clampTime(t)
      regs[REG_CONTROL_1]! &= ~CONTROL_1_STOP
      writeTimeRegs(c)
      latchFromRegs()
      evaluateAlarm()
      notify()
    },

    syncFromBrowser() {
      chip.setTime(browserNow())
    },

    getAlarms() {
      syncAdvance()
      const min = alarmField(REG_MINUTE_ALARM)
      const hour = alarmField(REG_HOUR_ALARM)
      const day = alarmField(REG_DAY_ALARM)
      const wday = alarmField(REG_WEEKDAY_ALARM)
      const armed = min.enabled || hour.enabled || day.enabled || wday.enabled
      const alarm: RtcAlarm = {
        id: 0,
        armed,
        pending: (regs[REG_CONTROL_2]! & CONTROL_2_AF) !== 0,
      }
      if (min.enabled) alarm.minute = min.value
      if (hour.enabled) alarm.hour = hour.value
      if (day.enabled) alarm.day = day.value
      if (wday.enabled) alarm.weekday = wday.value
      return [alarm]
    },

    setAlarm(id, fields) {
      if (id !== 0) return
      regs[REG_MINUTE_ALARM] =
        fields.minute !== undefined ? bin2bcd(fields.minute) & 0x7f : AEN
      regs[REG_HOUR_ALARM] =
        fields.hour !== undefined ? bin2bcd(fields.hour) & 0x3f : AEN
      regs[REG_DAY_ALARM] =
        fields.day !== undefined ? bin2bcd(fields.day) & 0x3f : AEN
      regs[REG_WEEKDAY_ALARM] =
        fields.weekday !== undefined ? bin2bcd(fields.weekday) & 0x07 : AEN
      // Arming a new alarm clears a stale fired flag, matching typical use.
      regs[REG_CONTROL_2]! &= ~CONTROL_2_AF
      syncAdvance()
      evaluateAlarm()
      notify()
    },

    clearAlarm(id) {
      if (id !== 0) return
      regs[REG_MINUTE_ALARM] = AEN
      regs[REG_HOUR_ALARM] = AEN
      regs[REG_DAY_ALARM] = AEN
      regs[REG_WEEKDAY_ALARM] = AEN
      regs[REG_CONTROL_2]! &= ~CONTROL_2_AF
      notify()
    },

    clearPending(id) {
      if (id !== 0) return
      regs[REG_CONTROL_2]! &= ~CONTROL_2_AF
      notify()
    },

    oscillatorStopped() {
      syncAdvance()
      return stopped() || (regs[REG_SECONDS]! & SECONDS_OS) !== 0
    },

    subscribe(fn) {
      listeners.add(fn)
      ensureTick()
      return () => {
        listeners.delete(fn)
      }
    },
  }

  return chip
}
