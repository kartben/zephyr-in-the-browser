import { useEffect, useReducer, useState } from 'react'
import { ControlRow } from '@/components/controls/ControlRow'
import {
  formatAlarm,
  formatRtcTime,
  type RtcChip,
} from '@/virtio/devices/rtc/model'

/**
 * RTC-shaped dock body: live clock, sync from the browser, and alarm
 * armed / fired state. Deliberately not a sensor card — datetime is not a
 * channel slider. Any {@link RtcChip} renders here, whatever bus carries it.
 */

const RTC_UI_MS = 100

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
    // Nudge once so the first paint is live even before a tick.
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
  // datetime-local: YYYY-MM-DDTHH:mm[:ss]
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

export function RtcBody({ chip }: { chip: RtcChip }) {
  useRtc(chip)
  const time = chip.getTime()
  const alarms = chip.getAlarms()
  const alarm = alarms[0]
  const osStop = chip.oscillatorStopped()
  const [draft, setDraft] = useState(() => toDatetimeLocalValue(time))
  const [alarmDraft, setAlarmDraft] = useState(() => {
    const pad = (n: number) => n.toString().padStart(2, '0')
    if (alarm?.hour !== undefined || alarm?.minute !== undefined) {
      return `${pad(alarm.hour ?? 0)}:${pad(alarm.minute ?? 0)}`
    }
    const inAMinute = new Date()
    inAMinute.setMinutes(inAMinute.getMinutes() + 1)
    return `${pad(inAMinute.getHours())}:${pad(inAMinute.getMinutes())}`
  })

  // Keep the datetime-local input roughly in step when the chip moves under us
  // (guest rtc set, sync), but do not fight mid-edit: only refresh when the
  // chip time's minute rolls or a sync lands far from the draft.
  useEffect(() => {
    const next = toDatetimeLocalValue(time)
    setDraft((prev) => (prev.slice(0, 16) === next.slice(0, 16) ? prev : next))
  }, [time.year, time.month, time.day, time.hour, time.minute])

  const applyDraft = () => {
    const parsed = fromDatetimeLocalValue(draft)
    if (parsed) chip.setTime(parsed)
  }

  const armAlarm = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(alarmDraft.trim())
    if (!m) return
    chip.setAlarm(0, { hour: Number(m[1]), minute: Number(m[2]) })
  }

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
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs">Alarm</span>
          <span
            className="font-mono text-[10px] tabular-nums text-muted-foreground"
            data-testid="rtc-alarm-status"
          >
            {alarm ? formatAlarm(alarm) : '—'}
            {alarm?.pending ? ' · fired' : ''}
          </span>
        </div>
        <ControlRow label="Time">
          <input
            type="time"
            value={alarmDraft}
            aria-label="Alarm time"
            onChange={(e) => setAlarmDraft(e.target.value)}
            className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] tabular-nums"
          />
        </ControlRow>
        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="rtc-arm-alarm"
            onClick={armAlarm}
            className="text-[10px] text-primary underline-offset-2 hover:underline"
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
        </div>
      </div>

      <Hints chip={chip} />
    </div>
  )
}

function Hints({ chip }: { chip: RtcChip }) {
  const name = chip.decl.shellLabel ?? 'RTC'
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      In the guest:{' '}
      <code className="font-mono text-foreground">rtc get {name}</code>,{' '}
      <code className="font-mono text-foreground">
        rtc set_alarm {name} 0 0x6 HH:MM:SS
      </code>{' '}
      (mask <code className="font-mono">0x6</code> = minute+hour). The alarm
      line above tracks those register writes.
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
        {pad(t.hour)}:{pad(t.minute)}:{pad(t.second)}
      </span>
    </span>
  )
}
