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

/**
 * Box-zoom vs pan: sticky mode makes drag zoom; Shift inverts whichever is
 * default so pan is never locked out.
 */
export function wantsBoxZoom(shiftKey: boolean, stickyMode: boolean): boolean {
  return stickyMode ? !shiftKey : shiftKey
}

/** Clamp a local X coordinate into the plot strip `[labelW, cssW - pad]`. */
export function clampPlotX(x: number, cssW: number, labelW: number, pad: number): number {
  const left = labelW
  const right = Math.max(left + 1, cssW - pad)
  return Math.min(right, Math.max(left, x))
}

/** Clamp a local Y into `[plotTop, plotBottom]`. */
export function clampPlotY(y: number, plotTop: number, plotBottom: number): number {
  const bottom = Math.max(plotTop + 1, plotBottom)
  return Math.min(bottom, Math.max(plotTop, y))
}

/**
 * Vertical viewport as fractions of the plot band below the time axis.
 * `{ f0: 0, f1: 1 }` is fully zoomed out.
 */
export type YZoom = { f0: number; f1: number }

export function isIdentityYZoom(z: YZoom | null | undefined): boolean {
  return !z || (z.f0 <= 1e-9 && z.f1 >= 1 - 1e-9)
}

export function clampYZoom(z: YZoom, minFrac = 0.04): YZoom {
  let f0 = Math.min(1, Math.max(0, z.f0))
  let f1 = Math.min(1, Math.max(0, z.f1))
  if (f1 < f0) {
    const tmp = f0
    f0 = f1
    f1 = tmp
  }
  if (f1 - f0 < minFrac) {
    const mid = (f0 + f1) / 2
    f0 = Math.max(0, mid - minFrac / 2)
    f1 = Math.min(1, f0 + minFrac)
    f0 = Math.max(0, f1 - minFrac)
  }
  return { f0, f1 }
}

/** Map a screen Y through the current vertical zoom into base (unzoomed) Y. */
export function screenYToBase(
  screenY: number,
  plotTop: number,
  plotBottom: number,
  yZoom: YZoom | null,
): number {
  const plotH = Math.max(1, plotBottom - plotTop)
  const z = yZoom && !isIdentityYZoom(yZoom) ? yZoom : { f0: 0, f1: 1 }
  const baseY0 = plotTop + z.f0 * plotH
  const baseY1 = plotTop + z.f1 * plotH
  const t = (screenY - plotTop) / plotH
  return baseY0 + t * (baseY1 - baseY0)
}

/** Inverse of {@link screenYToBase}. */
export function baseYToScreen(
  baseY: number,
  plotTop: number,
  plotBottom: number,
  yZoom: YZoom | null,
): number {
  const plotH = Math.max(1, plotBottom - plotTop)
  const z = yZoom && !isIdentityYZoom(yZoom) ? yZoom : { f0: 0, f1: 1 }
  const baseY0 = plotTop + z.f0 * plotH
  const baseY1 = plotTop + z.f1 * plotH
  const span = Math.max(1e-9, baseY1 - baseY0)
  return plotTop + ((baseY - baseY0) / span) * plotH
}

/**
 * Compose a nested vertical zoom from a screen-space strip selection.
 * Returns `null` when the drag is too short.
 */
export function yZoomFromScreenSelection(
  plotTop: number,
  plotBottom: number,
  yA: number,
  yB: number,
  current: YZoom | null,
  minPx = 8,
): YZoom | null {
  const a = clampPlotY(Math.min(yA, yB), plotTop, plotBottom)
  const b = clampPlotY(Math.max(yA, yB), plotTop, plotBottom)
  if (b - a < minPx) return null
  const plotH = Math.max(1, plotBottom - plotTop)
  const base0 = screenYToBase(a, plotTop, plotBottom, current)
  const base1 = screenYToBase(b, plotTop, plotBottom, current)
  return clampYZoom({
    f0: (base0 - plotTop) / plotH,
    f1: (base1 - plotTop) / plotH,
  })
}

/** Pan a vertical zoom by a screen-space delta (drag down → reveal content above). */
export function panYZoom(current: YZoom, plotH: number, dyScreen: number): YZoom {
  const span = Math.max(1e-9, current.f1 - current.f0)
  const dFrac = (-dyScreen / Math.max(1, plotH)) * span
  let f0 = current.f0 + dFrac
  let f1 = current.f1 + dFrac
  if (f0 < 0) {
    f0 = 0
    f1 = span
  }
  if (f1 > 1) {
    f1 = 1
    f0 = 1 - span
  }
  return { f0, f1 }
}

/**
 * Canvas transform so base Y in `[plotTop, plotBottom]` fills that band under
 * `yZoom`. Call after clipping to the plot band.
 */
export function applyYZoomTransform(
  ctx: CanvasRenderingContext2D,
  plotTop: number,
  plotBottom: number,
  yZoom: YZoom | null,
): void {
  if (!yZoom || isIdentityYZoom(yZoom)) return
  const plotH = Math.max(1, plotBottom - plotTop)
  const baseY0 = plotTop + yZoom.f0 * plotH
  const scale = 1 / Math.max(1e-9, yZoom.f1 - yZoom.f0)
  ctx.translate(0, plotTop - baseY0 * scale)
  ctx.scale(1, scale)
}

/** SVG transform matrix string matching {@link applyYZoomTransform}. */
export function yZoomSvgTransform(
  plotTop: number,
  plotBottom: number,
  yZoom: YZoom | null,
): string | null {
  if (!yZoom || isIdentityYZoom(yZoom)) return null
  const plotH = Math.max(1, plotBottom - plotTop)
  const baseY0 = plotTop + yZoom.f0 * plotH
  const scale = 1 / Math.max(1e-9, yZoom.f1 - yZoom.f0)
  const ty = plotTop - baseY0 * scale
  return `translate(0 ${ty}) scale(1 ${scale})`
}

/**
 * Map a horizontal box selection to a time window. Returns `null` when the
 * drag is too short to count as a zoom (keeps accidental Shift-clicks inert).
 */
export function viewFromBoxSelection(
  view: { t0: number; t1: number },
  cssW: number,
  labelW: number,
  pad: number,
  xA: number,
  xB: number,
  minPx = 8,
): { t0: number; t1: number } | null {
  const a = clampPlotX(xA, cssW, labelW, pad)
  const b = clampPlotX(xB, cssW, labelW, pad)
  if (Math.abs(b - a) < minPx) return null
  const layout: TraceTimeLayout = {
    labelW,
    pad,
    view0: view.t0,
    view1: view.t1,
    t0: view.t0,
  }
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return { t0: tsAt(layout, cssW, lo), t1: tsAt(layout, cssW, hi) }
}
