import { useEffect, useReducer, useState } from 'react'
import { CheckControl, ControlRow, SelectControl } from '@/components/controls/ControlRow'
import {
  alarmMask,
  formatAlarm,
  formatRtcTime,
  WEEKDAY_SHORT,
  type RtcAlarm,
  type RtcAlarmField,
  type RtcChip,
} from '@/virtio/devices/rtc/model'

/**
 * RTC-shaped dock body: live clock, sync from the browser, and alarm
 * armed / fired state across every compare field the chip declares
 * (PCF8523: minute, hour, day-of-month, weekday). Deliberately not a
 * sensor card — datetime is not a channel slider.
 */

const RTC_UI_MS = 100

const WEEKDAY_OPTIONS = WEEKDAY_SHORT.map((label, value) => ({ label, value }))

function useRtc(chip: RtcChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const refresh = () => {
      last = performance.now()
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      const now = performance.now()
      const wait = RTC_UI_MS - (now - last)
      if (wait <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        refresh()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        refresh()
      }, wait)
    })
    refresh()
    return () => {
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [chip])
}

function toDatetimeLocalValue(t: ReturnType<RtcChip['getTime']>): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`
}

function fromDatetimeLocalValue(value: string): ReturnType<RtcChip['getTime']> | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6] ?? 0)
  const weekday = new Date(year, month - 1, day).getDay()
  return { year, month, day, weekday, hour, minute, second }
}

/** Editable alarm draft: which compares are on, and their values. */
interface AlarmDraft {
  minuteOn: boolean
  hourOn: boolean
  dayOn: boolean
  weekdayOn: boolean
  minute: number
  hour: number
  day: number
  weekday: number
}

function draftFromAlarm(alarm: RtcAlarm | undefined, fallback: ReturnType<RtcChip['getTime']>): AlarmDraft {
  const inAMinute = (fallback.minute + 1) % 60
  const hourBump = fallback.minute === 59 ? (fallback.hour + 1) % 24 : fallback.hour
  return {
    minuteOn: alarm?.minute !== undefined,
    hourOn: alarm?.hour !== undefined,
    dayOn: alarm?.day !== undefined,
    weekdayOn: alarm?.weekday !== undefined,
    minute: alarm?.minute ?? (alarm?.armed ? 0 : inAMinute),
    hour: alarm?.hour ?? (alarm?.armed ? 0 : hourBump),
    day: alarm?.day ?? fallback.day,
    weekday: alarm?.weekday ?? fallback.weekday,
  }
}

function fieldsFromDraft(draft: AlarmDraft): {
  minute?: number
  hour?: number
  day?: number
  weekday?: number
} {
  const fields: { minute?: number; hour?: number; day?: number; weekday?: number } = {}
  if (draft.minuteOn) fields.minute = draft.minute
  if (draft.hourOn) fields.hour = draft.hour
  if (draft.dayOn) fields.day = draft.day
  if (draft.weekdayOn) fields.weekday = draft.weekday
  return fields
}

function alarmSignature(alarm: RtcAlarm | undefined): string {
  if (!alarm) return ''
  return [
    alarm.armed ? 1 : 0,
    alarm.minute ?? '',
    alarm.hour ?? '',
    alarm.day ?? '',
    alarm.weekday ?? '',
  ].join(':')
}

export function RtcBody({ chip }: { chip: RtcChip }) {
  useRtc(chip)
  const time = chip.getTime()
  const alarms = chip.getAlarms()
  const alarm = alarms[0]
  const osStop = chip.oscillatorStopped()
  const supported = new Set(chip.decl.alarmFields)
  const [draft, setDraft] = useState(() => toDatetimeLocalValue(time))
  const [alarmDraft, setAlarmDraft] = useState<AlarmDraft>(() => draftFromAlarm(alarm, time))

  useEffect(() => {
    const next = toDatetimeLocalValue(time)
    setDraft((prev) => (prev.slice(0, 16) === next.slice(0, 16) ? prev : next))
  }, [time.year, time.month, time.day, time.hour, time.minute])

  // Pull guest/page alarm register writes into the editors, without fighting
  // mid-edit when the signature has not actually changed.
  const sig = alarmSignature(alarm)
  useEffect(() => {
    setAlarmDraft(draftFromAlarm(alarm, time))
    // Only re-seed when the chip's armed fields change (guest rtc set_alarm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  const applyDraft = () => {
    const parsed = fromDatetimeLocalValue(draft)
    if (parsed) chip.setTime(parsed)
  }

  const armAlarm = () => {
    const fields = fieldsFromDraft(alarmDraft)
    if (Object.keys(fields).length === 0) return
    chip.setAlarm(0, fields)
  }

  const setField = <K extends keyof AlarmDraft>(key: K, value: AlarmDraft[K]) => {
    setAlarmDraft((prev) => ({ ...prev, [key]: value }))
  }

  const toggle = (field: RtcAlarmField, on: boolean) => {
    const key = `${field}On` as const
    setAlarmDraft((prev) => ({ ...prev, [key]: on }))
  }

  const draftFields = fieldsFromDraft(alarmDraft)
  const draftMask = alarmMask(draftFields)

  return (
    <div className="space-y-2 px-3 py-2.5" data-testid="rtc-body">
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-sm tabular-nums tracking-tight text-foreground"
          data-testid="rtc-time"
        >
          {formatRtcTime(time)}
        </span>
        {osStop && (
          <span className="rounded border border-border px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
            OS
          </span>
        )}
        {alarm?.pending && (
          <span
            className="rounded border border-primary/40 bg-primary/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-primary"
            data-testid="rtc-alarm-fired"
          >
            alarm
          </span>
        )}
      </div>

      <ControlRow label="Set">
        <input
          type="datetime-local"
          step={1}
          value={draft}
          aria-label="RTC date and time"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={applyDraft}
          className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
        />
      </ControlRow>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="rtc-sync"
          onClick={() => {
            chip.syncFromBrowser()
            setDraft(toDatetimeLocalValue(chip.getTime()))
          }}
          className="text-[10px] text-primary underline-offset-2 hover:underline"
        >
          Sync from browser
        </button>
        <button
          type="button"
          onClick={applyDraft}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Apply
        </button>
      </div>

      <div className="border-t border-border/60 pt-2">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs">Alarm</span>
          <span
            className="font-mono text-[10px] tabular-nums text-muted-foreground"
            data-testid="rtc-alarm-status"
          >
            {alarm ? formatAlarm(alarm) : '—'}
            {alarm?.pending ? ' · fired' : ''}
          </span>
        </div>

        <div className="mb-1.5 flex flex-wrap gap-1.5" data-testid="rtc-alarm-fields">
          {supported.has('minute') && (
            <CheckControl
              label="Minute"
              checked={alarmDraft.minuteOn}
              onChange={(on) => toggle('minute', on)}
            />
          )}
          {supported.has('hour') && (
            <CheckControl
              label="Hour"
              checked={alarmDraft.hourOn}
              onChange={(on) => toggle('hour', on)}
            />
          )}
          {supported.has('day') && (
            <CheckControl
              label="Day"
              checked={alarmDraft.dayOn}
              onChange={(on) => toggle('day', on)}
            />
          )}
          {supported.has('weekday') && (
            <CheckControl
              label="Weekday"
              checked={alarmDraft.weekdayOn}
              onChange={(on) => toggle('weekday', on)}
            />
          )}
        </div>

        {supported.has('hour') && alarmDraft.hourOn && (
          <ControlRow label="Hour">
            <input
              type="number"
              min={0}
              max={23}
              value={alarmDraft.hour}
              aria-label="Alarm hour"
              onChange={(e) => setField('hour', Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
              className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
            />
          </ControlRow>
        )}
        {supported.has('minute') && alarmDraft.minuteOn && (
          <ControlRow label="Minute">
            <input
              type="number"
              min={0}
              max={59}
              value={alarmDraft.minute}
              aria-label="Alarm minute"
              onChange={(e) =>
                setField('minute', Math.min(59, Math.max(0, Number(e.target.value) || 0)))
              }
              className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
            />
          </ControlRow>
        )}
        {supported.has('day') && alarmDraft.dayOn && (
          <ControlRow label="Day">
            <input
              type="number"
              min={1}
              max={31}
              value={alarmDraft.day}
              aria-label="Alarm day of month"
              onChange={(e) => setField('day', Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
              className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
            />
          </ControlRow>
        )}
        {supported.has('weekday') && alarmDraft.weekdayOn && (
          <SelectControl
            label="Weekday"
            value={alarmDraft.weekday}
            options={[...WEEKDAY_OPTIONS]}
            onChange={(value) => setField('weekday', value)}
          />
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="rtc-arm-alarm"
            onClick={armAlarm}
            disabled={draftMask === 0}
            className="text-[10px] text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
          >
            Arm
          </button>
          <button
            type="button"
            data-testid="rtc-clear-alarm"
            onClick={() => chip.clearAlarm(0)}
            className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Clear
          </button>
          {alarm?.pending && (
            <button
              type="button"
              data-testid="rtc-ack-alarm"
              onClick={() => chip.clearPending(0)}
              className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            >
              Ack fired
            </button>
          )}
          {draftMask !== 0 && (
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/80">
              mask 0x{draftMask.toString(16)}
            </span>
          )}
        </div>
      </div>

      <Hints chip={chip} />
    </div>
  )
}

function Hints({ chip }: { chip: RtcChip }) {
  const name = chip.decl.shellLabel ?? 'RTC'
  const fields = chip.decl.alarmFields
  const mask = fields.reduce((m, f) => m | alarmMask({ [f]: 0 }), 0)
  const fieldList = fields
    .map((f) => (f === 'day' ? 'monthday' : f))
    .join('+')
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      In the guest:{' '}
      <code className="font-mono text-foreground">rtc get {name}</code>,{' '}
      <code className="font-mono text-foreground">
        rtc set_alarm {name} 0 0x{mask.toString(16)} …
      </code>{' '}
      (mask <code className="font-mono">0x{mask.toString(16)}</code> = {fieldList}). Tick the
      compare fields above; the status line tracks guest register writes too.
    </p>
  )
}

/** Collapsed-row badge: HH:MM:SS, with a fired dot when AF is set. */
export function RtcBadge({ chip }: { chip: RtcChip }) {
  useRtc(chip)
  const t = chip.getTime()
  const pending = chip.getAlarms().some((a) => a.pending)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    <span className="flex items-center gap-1.5">
      {pending && (
        <span
          className="size-1.5 rounded-full bg-primary"
          role="status"
          aria-label="Alarm fired"
        />
      )}
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
        {WEEKDAY_SHORT[t.weekday]} {pad(t.hour)}:{pad(t.minute)}:{pad(t.second)}
      </span>
    </span>
  )
}
