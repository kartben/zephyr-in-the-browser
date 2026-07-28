/**
 * Shared Trace chart helpers — time mapping, canvas axis, playhead stroke.
 *
 * CTF timestamps are monotonic nanoseconds from Zephyr `timing_ns_get()`
 * (not `k_uptime_ticks()`). Tips and axis labels use that absolute guest
 * clock only. Kernel uptime ticks are not in the stream unless we learn
 * `CONFIG_SYS_CLOCK_TICKS_PER_SEC` separately.
 */

import { fmtAxisTime, timeTickValues } from '@/ctf'

export type TraceTimeLayout = {
  labelW: number
  pad: number
  view0: number
  view1: number
  /** Trace epoch (first event ts) — layout identity only, not for labels. */
  t0: number
}

export function plotWidth(cssW: number, labelW: number, pad: number): number {
  return Math.max(1, cssW - labelW - pad)
}

export function xAt(layout: TraceTimeLayout, cssW: number, ts: number): number {
  const plotW = plotWidth(cssW, layout.labelW, layout.pad)
  const span = Math.max(1, layout.view1 - layout.view0)
  return layout.labelW + ((ts - layout.view0) / span) * plotW
}

export function tsAt(layout: TraceTimeLayout, cssW: number, x: number): number {
  const plotW = plotWidth(cssW, layout.labelW, layout.pad)
  const span = Math.max(1, layout.view1 - layout.view0)
  const frac = Math.min(1, Math.max(0, (x - layout.labelW) / plotW))
  return layout.view0 + frac * span
}

/** Absolute guest CTF ns (`timing_ns_get`), step-aware units. */
export function formatGuestTime(ts: number, stepNs: number): string {
  return fmtAxisTime(ts, stepNs)
}

/** Tick step for the current window (shared by Timeline / Queues tips). */
export function windowTimeStep(view0: number, view1: number, plotW: number): number {
  return timeTickValues(view0, view1, Math.max(4, Math.floor(plotW / 56))).step
}

const AXIS_STROKE = 'rgba(148, 163, 184, 0.45)'
const AXIS_FILL = 'rgba(148, 163, 184, 0.9)'
const AXIS_EDGE = 'rgba(226, 232, 240, 0.95)'

/**
 * Canvas time ruler matching the Queues d3 axis language (fmtAxisTime + denser ticks).
 * Labels are absolute guest CTF ns.
 */
export function paintCanvasTimeAxis(
  ctx: CanvasRenderingContext2D,
  opts: {
    cssW: number
    labelW: number
    pad: number
    view0: number
    view1: number
    t0: number
    follow: boolean
    /** Y of the axis baseline. */
    baselineY?: number
  },
): { step: number; values: number[] } {
  const {
    cssW,
    labelW,
    pad,
    view0,
    view1,
    t0,
    follow,
    baselineY = 18,
  } = opts
  const plotW = plotWidth(cssW, labelW, pad)
  const { values, step } = timeTickValues(view0, view1, Math.max(4, Math.floor(plotW / 56)))

  ctx.fillStyle = AXIS_FILL
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(labelW, cssW - 32), 12)
  } else {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)'
    ctx.fillText('t →', 4, 12)
  }

  ctx.strokeStyle = AXIS_STROKE
  ctx.fillStyle = AXIS_FILL
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(labelW, baselineY)
  ctx.lineTo(labelW + plotW, baselineY)
  ctx.stroke()

  for (const t of values) {
    const x = xAt({ labelW, pad, view0, view1, t0 }, cssW, t)
    if (x < labelW - 0.5 || x > labelW + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, baselineY - 4)
    ctx.lineTo(x, baselineY + 4)
    ctx.stroke()
    const label = fmtAxisTime(t, step)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(labelW, Math.min(labelW + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = AXIS_EDGE
  const leftLbl = fmtAxisTime(view0, step)
  const rightLbl = fmtAxisTime(view1, step)
  ctx.fillText(leftLbl, labelW, 26)
  ctx.fillText(rightLbl, labelW + plotW - ctx.measureText(rightLbl).width, 26)

  return { step, values }
}

/** Dashed vertical playhead across the plot. */
export function paintPlayhead(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y0: number; y1: number },
): void {
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.55)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(opts.x, opts.y0)
  ctx.lineTo(opts.x, opts.y1)
  ctx.stroke()
  ctx.setLineDash([])
}
