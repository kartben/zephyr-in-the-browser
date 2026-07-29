/**
 * CPU residency lane + duty strip — shares the Trace time window.
 * Phase 1 of docs/trace-power-plan.md (schedule-derived; not pm_* CTF yet).
 */

import {
  useEffect,
  useMemo,
  useRef,
  type CanvasHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import { applyYZoomTransform, type YZoom } from '@/components/traceChart'
import {
  dutyBuckets,
  formatPct,
  formatResidencyDuration,
  reconstructCpuResidency,
  residencyWindowStats,
  type CpuResidency,
  type Trace,
  fmtTime,
  niceTimeStep,
} from '@/ctf'

const LABEL_W = 108
const PAD = 8
const AXIS_H = 28
const LANE_H = 64
const STRIP_H = 56
const STRIP_GAP = 10

const COL_ACTIVE = 'rgba(245, 158, 11, 0.82)'
const COL_ACTIVE_TOP = 'rgba(251, 191, 36, 0.95)'
const COL_IDLE = 'rgba(100, 116, 139, 0.42)'
const COL_WAKE = 'rgba(52, 211, 153, 0.95)'
const COL_DUTY = 'rgba(56, 189, 248, 0.85)'

function paint(
  canvas: HTMLCanvasElement,
  res: CpuResidency,
  view0: number,
  view1: number,
  follow: boolean,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const cssH = Math.max(140, AXIS_H + LANE_H + STRIP_GAP + STRIP_H + 8)
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const plotW = Math.max(1, cssW - LABEL_W - PAD)
  const span = Math.max(1, view1 - view0)
  const xAt = (t: number) => LABEL_W + ((t - view0) / span) * plotW

  ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('t', 4, 12)

  const step = niceTimeStep(span, Math.max(3, Math.floor(plotW / 72)))
  const firstTick = Math.ceil(view0 / step) * step
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(LABEL_W, 18)
  ctx.lineTo(LABEL_W + plotW, 18)
  ctx.stroke()

  for (let t = firstTick; t <= view1 + step * 0.01; t += step) {
    const x = xAt(t)
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = fmtTime(t)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  const leftLbl = fmtTime(view0)
  const rightLbl = fmtTime(view1)
  ctx.fillText(leftLbl, LABEL_W, 26)
  ctx.fillText(rightLbl, LABEL_W + plotW - ctx.measureText(rightLbl).width, 26)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  const laneTop = AXIS_H + 4
  const laneBottom = AXIS_H + LANE_H - 4
  const laneMid = (laneTop + laneBottom) / 2

  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText('CPU', 10, laneMid - 4)
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('residency', 10, laneMid + 10)

  if (res.segments.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('Waiting for schedule CTF…', LABEL_W, laneMid)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.95)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(
      'Idle residency is derived from the idle thread’s run spans (any *_trace sample).',
      LABEL_W,
      laneMid + 16,
    )
    canvas.style.height = `${cssH}px`
    return
  }

  // Track behind the bands
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)'
  ctx.fillRect(LABEL_W, laneTop, plotW, laneBottom - laneTop)

  for (const seg of res.segments) {
    if (seg.end <= view0 || seg.start >= view1) continue
    const x0 = Math.max(LABEL_W, xAt(seg.start))
    const x1 = Math.min(LABEL_W + plotW, xAt(seg.end))
    const w = Math.max(1, x1 - x0)
    if (seg.mode === 'active') {
      const g = ctx.createLinearGradient(0, laneTop, 0, laneBottom)
      g.addColorStop(0, COL_ACTIVE_TOP)
      g.addColorStop(1, COL_ACTIVE)
      ctx.fillStyle = g
    } else {
      ctx.fillStyle = COL_IDLE
    }
    ctx.fillRect(x0, laneTop, w, laneBottom - laneTop)
  }

  // Wake ticks
  for (const wake of res.wakes) {
    if (wake.ts < view0 || wake.ts > view1) continue
    const x = xAt(wake.ts)
    if (x < LABEL_W || x > LABEL_W + plotW) continue
    ctx.strokeStyle = COL_WAKE
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, laneTop - 6)
    ctx.lineTo(x, laneBottom)
    ctx.stroke()
    ctx.fillStyle = COL_WAKE
    ctx.beginPath()
    ctx.arc(x, laneTop - 6, 2.4, 0, Math.PI * 2)
    ctx.fill()
  }

  if (!res.hasIdleThread) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.75)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No thread named idle — showing all run time as active.', LABEL_W, laneBottom + 14)
  }

  // Duty strip
  const stripTop = AXIS_H + LANE_H + STRIP_GAP
  const stripBottom = stripTop + STRIP_H - 8
  ctx.strokeStyle = 'rgba(42, 51, 66, 0.95)'
  ctx.beginPath()
  ctx.moveTo(8, stripTop - 4)
  ctx.lineTo(cssW - 8, stripTop - 4)
  ctx.stroke()

  ctx.fillStyle = 'rgba(106, 115, 130, 0.95)'
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('DUTY · BUCKETED BUSY %', 10, stripTop + 10)

  const bucketCount = Math.max(24, Math.min(64, Math.floor(plotW / 10)))
  const buckets = dutyBuckets(res, view0, view1, bucketCount)
  const bw = plotW / buckets.length
  const barH = stripBottom - (stripTop + 16)
  for (let i = 0; i < buckets.length; i++) {
    const frac = buckets[i]!
    const h = Math.max(frac > 0 ? 2 : 0, frac * barH)
    const x = LABEL_W + i * bw
    const y = stripBottom - h
    ctx.fillStyle = COL_DUTY
    ctx.globalAlpha = 0.35 + frac * 0.65
    ctx.fillRect(x + 1, y, Math.max(1, bw - 2), h)
  }
  ctx.globalAlpha = 1

  ctx.fillStyle = 'rgba(106, 115, 130, 0.9)'
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText('100%', LABEL_W + plotW + 4 > cssW - 4 ? cssW - 36 : LABEL_W + plotW - 28, stripTop + 18)
  ctx.fillText('0%', LABEL_W + plotW - 18, stripBottom)

  canvas.style.height = `${cssH}px`
}

export function PowerView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  canvasRef,
  canvasProps,
  overlay,
  boxZoomArmed = false,
  yZoom = null,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
  overlay?: ReactNode
  boxZoomArmed?: boolean
  yZoom?: YZoom | null
}) {
  const residency = useMemo(
    () => reconstructCpuResidency(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const stats = useMemo(
    () => residencyWindowStats(residency, view0, view1),
    [residency, view0, view1],
  )
  const resRef = useRef(residency)
  const yZoomRef = useRef(yZoom)
  resRef.current = residency
  yZoomRef.current = yZoom

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, residency, view0, view1, follow, yZoom)
  }, [residency, view0, view1, follow, canvasRef, yZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(canvas, resRef.current, view0, view1, follow, yZoomRef.current)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [view0, view1, follow, canvasRef])

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span>
          busy{' '}
          <span className="font-mono text-amber-400/90">{formatPct(stats.busyPct)}</span>
        </span>
        <span>
          idle <span className="font-mono text-slate-300/90">{formatPct(stats.idlePct)}</span>
        </span>
        <span>
          wakes <span className="font-mono text-emerald-400/90">{stats.wakeCount}</span>
        </span>
        <span>
          mean idle{' '}
          <span className="font-mono text-foreground">
            {formatResidencyDuration(stats.meanIdleNs)}
          </span>
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-amber-400" />
            active
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-slate-500" />
            idle
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-emerald-400" />
            wake
          </span>
        </span>
      </div>
      <div className="relative w-full select-none">
        <canvas
          ref={canvasRef}
          className={cn(
            'w-full touch-none select-none rounded border border-border/60 bg-slate-950/40',
            boxZoomArmed ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
          )}
          {...canvasProps}
        />
        {overlay}
      </div>
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const POWER_LABEL_W = LABEL_W
