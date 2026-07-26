/**
 * Dock body for any {@link PwmChip}.
 *
 * Paints an annotated square wave for the selected channel (full period
 * centered, ~⅓ period of context on each side), a fixed-height channel strip,
 * optional detail metrics, and the shared Registers dialog.
 * Provider-agnostic — do not import PCA9685 here.
 *
 * Visual updates coalesce on requestAnimationFrame (same pattern as the OLED
 * panel). The stock LED PWM sample fades one brightness step every ~10 ms;
 * a 50 ms timer throttle made that look choppy, and rebuilding the canvas from
 * a React `useEffect([ch])` paid the full paint cost on every throttle tick.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import { RegisterMapButton } from '@/components/RegisterMap'
import {
  formatPwmDuration,
  formatPwmDuty,
  formatPwmFrequency,
  type PwmChip,
} from '@/virtio/devices/pwm/model'

/** Side context as a fraction of one period (⅓ on each side of the center T). */
const SIDE = 1 / 3
const T_MIN = -SIDE
const T_MAX = 1 + SIDE

/**
 * Re-render on chip changes, coalesced to one frame. Matches OLED/HexView —
 * guest I²C bursts notify more than once per logical update, and fade steps
 * land faster than a 50 ms UI timer can show.
 */
function useChip(chip: PwmChip) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let frame = 0
    const refresh = () => {
      frame = 0
      force()
    }
    const unsubscribe = chip.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(refresh)
    })
    refresh()
    return () => {
      unsubscribe()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [chip])
}

/** Instantaneous output level: 1 = HIGH, 0 = LOW. */
function levelAt(t: number, duty: number, flat: boolean, fullOn: boolean): number {
  if (flat) return fullOn ? 1 : 0
  if (duty <= 0) return 0
  if (duty >= 1) return 1
  const phase = ((t % 1) + 1) % 1
  return phase < duty ? 1 : 0
}

type WavePt = { t: number; level: number }

/** Continuous square-wave polyline from t0→t1, with vertical edges at transitions. */
function buildWavePoints(
  t0: number,
  t1: number,
  duty: number,
  flat: boolean,
  fullOn: boolean,
): WavePt[] {
  const pts: WavePt[] = [{ t: t0, level: levelAt(t0, duty, flat, fullOn) }]
  if (flat || duty <= 0 || duty >= 1) {
    pts.push({ t: t1, level: levelAt(t1, duty, flat, fullOn) })
    return pts
  }

  const edges: number[] = []
  const k0 = Math.floor(t0) - 1
  const k1 = Math.ceil(t1) + 1
  for (let k = k0; k <= k1; k++) {
    for (const e of [k, k + duty]) {
      if (e > t0 && e < t1) edges.push(e)
    }
  }
  edges.sort((a, b) => a - b)
  let prev = t0
  for (const e of edges) {
    if (e - prev < 1e-12) continue
    const before = levelAt(e - 1e-9, duty, flat, fullOn)
    const after = levelAt(e + 1e-9, duty, flat, fullOn)
    pts.push({ t: e, level: before })
    if (before !== after) pts.push({ t: e, level: after })
    prev = e
  }
  pts.push({ t: t1, level: levelAt(t1, duty, flat, fullOn) })
  return pts
}

function strokeWave(
  ctx: CanvasRenderingContext2D,
  pts: WavePt[],
  xAt: (t: number) => number,
  yAt: (level: number) => number,
) {
  if (pts.length === 0) return
  ctx.beginPath()
  ctx.moveTo(xAt(pts[0]!.t), yAt(pts[0]!.level))
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xAt(pts[i]!.t), yAt(pts[i]!.level))
  }
  ctx.stroke()
}

/** Stroke the same continuous path inside a time window (solid vs dotted). */
function strokeWaveClipped(
  ctx: CanvasRenderingContext2D,
  pts: WavePt[],
  xAt: (t: number) => number,
  yAt: (level: number) => number,
  tA: number,
  tB: number,
  cssH: number,
) {
  const x0 = xAt(tA)
  const x1 = xAt(tB)
  ctx.save()
  ctx.beginPath()
  // Pad a hair so vertical edges exactly on the boundary stay visible.
  ctx.rect(Math.min(x0, x1) - 1, 0, Math.abs(x1 - x0) + 2, cssH)
  ctx.clip()
  strokeWave(ctx, pts, xAt, yAt)
  ctx.restore()
}

const WAVE_H = 196

/**
 * Paints from the chip directly via rAF — not through a React channel object.
 * `getChannel()` returns a fresh object every call, so a `useEffect([ch])`
 * redraw would always fire after every parent re-render even when duty is
 * unchanged; version + index skips those no-ops.
 */
function WaveformCanvas({ chip, index }: { chip: PwmChip; index: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let frame = 0
    let paintedVersion = -1
    let paintedIndex = -1
    let paintedWidth = -1

    const paint = () => {
      frame = 0
      const cssW = canvas.clientWidth || 360
      const version = chip.version()
      if (version === paintedVersion && index === paintedIndex && cssW === paintedWidth) {
        return
      }
      paintedVersion = version
      paintedIndex = index
      paintedWidth = cssW

      const ch = chip.getChannel(index)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cssH = WAVE_H
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const padL = 14
      const padR = 14
      const padT = 44
      const padB = 38
      const plotW = cssW - padL - padR
      const plotH = cssH - padT - padB
      const yHigh = padT + 14
      const yLow = padT + plotH - 14
      const span = T_MAX - T_MIN
      const xAt = (t: number) => padL + ((t - T_MIN) / span) * plotW
      const yAt = (level: number) => (level >= 0.5 ? yHigh : yLow)

      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = '#0c0e12'
      ctx.fillRect(0, 0, cssW, cssH)

      // Faint grid
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      for (let i = 1; i < 4; i++) {
        const x = padL + (plotW * i) / 4
        ctx.beginPath()
        ctx.moveTo(x, padT)
        ctx.lineTo(x, padT + plotH)
        ctx.stroke()
      }

      const flat = ch.fullOn || ch.fullOff || ch.periodNs <= 0
      const duty = flat ? (ch.fullOn ? 1 : 0) : Math.max(0, Math.min(1, ch.duty))
      const fullOn = ch.fullOn || (!flat && duty >= 1)

      // One continuous square-wave polyline. Clip when stroking so the sides are
      // dotted and the center period is solid — splitting the path at 0/T was
      // dropping the vertical edges (and drawing diagonals).
      const pts = buildWavePoints(T_MIN, T_MAX, duty, flat, fullOn)

      ctx.strokeStyle = '#3ecf8e'
      ctx.lineWidth = 2
      ctx.lineJoin = 'miter'
      ctx.miterLimit = 2
      ctx.lineCap = 'butt'

      ctx.setLineDash([4, 3])
      strokeWaveClipped(ctx, pts, xAt, yAt, T_MIN, 0, cssH)
      strokeWaveClipped(ctx, pts, xAt, yAt, 1, T_MAX, cssH)

      ctx.setLineDash([])
      strokeWaveClipped(ctx, pts, xAt, yAt, 0, 1, cssH)

      // Period boundary guides
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.setLineDash([3, 3])
      for (const t of [0, 1]) {
        ctx.beginPath()
        ctx.moveTo(xAt(t), padT)
        ctx.lineTo(xAt(t), padT + plotH)
        ctx.stroke()
      }
      // Falling-edge guide inside the center period
      if (!flat && duty > 0 && duty < 1) {
        ctx.beginPath()
        ctx.moveTo(xAt(duty), padT)
        ctx.lineTo(xAt(duty), padT + plotH)
        ctx.stroke()
      }
      ctx.setLineDash([])

      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textAlign = 'center'
      if (!flat && duty > 0.02 && duty < 0.98) {
        ctx.fillText('HIGH', xAt(duty / 2), yHigh - 8)
        ctx.fillText('LOW', xAt((duty + 1) / 2), yLow + 16)

        // Fixed anchors at the period edges — values update, positions don't.
        ctx.textAlign = 'left'
        ctx.fillText(`t_high = ${formatPwmDuration(ch.pulseNs)}`, xAt(0) + 4, padT - 12)
        ctx.textAlign = 'right'
        ctx.fillText(
          `t_low = ${formatPwmDuration(ch.periodNs - ch.pulseNs)}`,
          xAt(1) - 4,
          padT - 12,
        )
      } else if (flat) {
        ctx.textAlign = 'left'
        ctx.fillText(ch.fullOn ? 'full-on' : 'full-off', padL + 4, yHigh - 8)
      }

      const chipLabel = flat
        ? ch.fullOn
          ? 'full-on'
          : 'full-off'
        : `${formatPwmDuty(duty)} duty · ${formatPwmFrequency(ch.periodNs)}`
      ctx.textAlign = 'right'
      ctx.fillStyle = 'rgba(62,207,142,0.9)'
      ctx.fillText(chipLabel, cssW - padR, 14)

      // Period bracket under the solid center period
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.textAlign = 'center'
      const yBracket = cssH - 16
      const x0 = xAt(0)
      const xT = xAt(1)
      ctx.beginPath()
      ctx.moveTo(x0, yBracket - 4)
      ctx.lineTo(x0, yBracket)
      ctx.lineTo(xT, yBracket)
      ctx.lineTo(xT, yBracket - 4)
      ctx.stroke()
      ctx.fillText(`T = ${formatPwmDuration(ch.periodNs)}`, (x0 + xT) / 2, yBracket - 8)

      // X ticks
      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      for (const [label, t] of [
        ['−T/3', T_MIN],
        ['0', 0],
        ['T/2', 0.5],
        ['T', 1],
        ['T+T/3', T_MAX],
      ] as const) {
        ctx.fillText(label, xAt(t), cssH - 4)
      }
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint)
    }

    paint()
    const unsubscribe = chip.subscribe(schedule)
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            paintedWidth = -1
            schedule()
          })
        : undefined
    ro?.observe(canvas)

    return () => {
      unsubscribe()
      ro?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [chip, index])

  return (
    <canvas
      ref={canvasRef}
      aria-label={`PWM channel ${index} waveform`}
      className="block h-[196px] w-full shrink-0 rounded border border-border bg-black"
    />
  )
}

const TRACK_H = 24
const MIN_FILL = 5
/** Label row is always this tall so "0" vs "CH0" never resizes the strip. */
const LABEL_H = 12

function ChannelStrip({
  chip,
  selected,
  onSelect,
}: {
  chip: PwmChip
  selected: number
  onSelect: (n: number) => void
}) {
  const n = chip.decl.channelCount
  return (
    <div
      className="flex h-[44px] shrink-0 items-stretch gap-0.5"
      role="listbox"
      aria-label="PWM channels"
    >
      {Array.from({ length: n }, (_, i) => {
        const ch = chip.getChannel(i)
        const fill = Math.round(MIN_FILL + ch.duty * (TRACK_H - MIN_FILL))
        const active = i === selected
        return (
          <button
            key={i}
            type="button"
            role="option"
            aria-selected={active}
            title={`CH${i} · ${formatPwmDuty(ch.duty)}`}
            onClick={() => onSelect(i)}
            className={
              active
                ? 'flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5 rounded border border-primary/70 bg-primary/10 px-0.5 py-0.5'
                : 'flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5 rounded border border-transparent px-0.5 py-0.5 hover:bg-muted/40'
            }
          >
            <span
              className="flex w-full shrink-0 items-end"
              style={{ height: TRACK_H }}
              aria-hidden
            >
              <span
                className={
                  active
                    ? 'w-full rounded-sm bg-primary'
                    : ch.duty > 0
                      ? 'w-full rounded-sm bg-success/70'
                      : 'w-full rounded-sm bg-muted-foreground/25'
                }
                style={{ height: fill }}
              />
            </span>
            <span
              className="flex w-full shrink-0 items-center justify-center font-mono text-[8px] tabular-nums text-muted-foreground"
              style={{ height: LABEL_H }}
            >
              {i}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function PwmBody({ chip }: { chip: PwmChip }) {
  useChip(chip)
  const [selected, setSelected] = useState(0)
  const sel = Math.min(selected, Math.max(0, chip.decl.channelCount - 1))
  const ch = chip.getChannel(sel)

  const details = (chip.decl.detailKeys ?? [])
    .map((key) => {
      const value = chip.getDetail?.(key)
      return value ? `${key === 'prescale' ? 'PRE_SCALE' : key} ${value}` : null
    })
    .filter(Boolean)

  const countHint =
    ch.fullOn || ch.fullOff
      ? ch.fullOn
        ? 'full-on'
        : 'full-off'
      : `duty ${formatPwmDuty(ch.duty)}`

  return (
    <div className="space-y-2.5 px-3 py-3.5">
      <WaveformCanvas chip={chip} index={sel} />
      <ChannelStrip chip={chip} selected={sel} onSelect={setSelected} />
      <div className="flex min-h-[16px] flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          CH{sel} · {countHint}
          {ch.inverted ? ' · inv' : ''}
        </span>
        {details.map((d) => (
          <span key={d} className="font-mono tabular-nums">
            {d}
          </span>
        ))}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <code className="font-mono text-foreground">{chip.decl.name}</code>
        {' — '}
        {chip.decl.channelCount}-channel PWM
        {chip.decl.periodScope === 'controller' ? ' (shared period)' : ''}
        {chip.address != null ? ` at 0x${chip.address.toString(16)}` : ''}.
      </p>
      <RegisterMapButton chip={chip} />
    </div>
  )
}

/** Collapsed-row / group summary — live via rAF. */
export function PwmBadge({
  chip,
  variant = 'channel',
}: {
  chip: PwmChip
  /** `channel` = "CH0 · 35%"; `count` = "16 ch · 35%" for the ▤ group header. */
  variant?: 'channel' | 'count'
}) {
  useChip(chip)
  const ch = chip.getChannel(0)
  const duty = formatPwmDuty(ch.duty)
  return (
    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
      {variant === 'count' ? `${chip.decl.channelCount} ch · ${duty}` : `CH0 · ${duty}`}
    </span>
  )
}
