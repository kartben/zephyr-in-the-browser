/**
 * Sync hold / wait / handoff swimlanes — shares the Trace time window.
 *
 * Object-centric twin of Timeline: each mutex / semaphore / condvar is a lane
 * showing who holds it, who waits, and unlock/give → claim handoffs.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CanvasHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import {
  applyYZoomTransform,
  formatGuestTime,
  windowTimeStep,
  type YZoom,
} from '@/components/traceChart'
import {
  fmtTime,
  nearestSyncMark,
  reconstructSync,
  syncCountAt,
  syncKindLabel,
  syncLabel,
  syncOpLabel,
  syncWindowStats,
  threadLabel,
  type SyncMark,
  type SyncSeries,
  type Trace,
} from '@/ctf'

const LABEL_W = 120
const PAD = 8
const AXIS_H = 28
const ROW_H = 48
const HOLD_H = 10
const WAIT_Y = 8
const SNAP_PX = 10

const COL_WAIT = 'rgba(251, 191, 36, 0.85)'
const COL_WAIT_INV = 'rgba(251, 113, 133, 0.95)'
const COL_HANDOFF = 'rgba(167, 243, 208, 0.9)'
const COL_COUNT = 'rgba(147, 197, 253, 0.95)'
const COL_MARK = 'rgba(226, 232, 240, 0.75)'
const COL_ERR = 'rgba(248, 113, 113, 0.95)'
const COL_INV_STROKE = 'rgba(251, 113, 133, 0.95)'

/** Stable pastel fill for a thread id (ownership colour). */
function ownerFill(tid: number): string {
  const hue = (tid * 47) % 360
  return `hsla(${hue}, 55%, 55%, 0.72)`
}

function paint(
  canvas: HTMLCanvasElement,
  _tr: Trace,
  series: SyncSeries[],
  view0: number,
  view1: number,
  follow: boolean,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const rows = Math.max(1, series.length)
  const cssH = Math.max(120, AXIS_H + rows * ROW_H + 8)
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
  const xOf = (ts: number) => LABEL_W + ((ts - view0) / span) * plotW

  // Time axis
  ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('t', 4, 12)

  const step = windowTimeStep(view0, view1, plotW)
  const firstTick = Math.ceil(view0 / step) * step
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(LABEL_W, 18)
  ctx.lineTo(LABEL_W + plotW, 18)
  ctx.stroke()

  for (let t = firstTick; t <= view1 + step * 0.01; t += step) {
    const x = xOf(t)
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = formatGuestTime(t, step)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  ctx.fillText(fmtTime(view0), LABEL_W, 26)
  const rightLbl = fmtTime(view1)
  ctx.fillText(rightLbl, LABEL_W + plotW - ctx.measureText(rightLbl).width, 26)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  if (series.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No semaphore, mutex, or condition-variable events yet.', LABEL_W, AXIS_H + 28)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.9)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('Try the philosophers sample — forks are mutexes.', LABEL_W, AXIS_H + 48)
    canvas.style.height = `${cssH}px`
    return
  }

  // Peak sem count in view for vertical scaling.
  let peakCount = 1
  for (const s of series) {
    if (s.kind !== 'sem') continue
    for (const c of s.countSamples) {
      if (c.ts < view0 || c.ts > view1) continue
      if (c.count > peakCount) peakCount = c.count
    }
    const edge = syncCountAt(s.countSamples, view0)
    if (edge > peakCount) peakCount = edge
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, AXIS_H, cssW, Math.max(1, cssH - AXIS_H))
  ctx.clip()
  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  series.forEach((s, row) => {
    const y0 = AXIS_H + row * ROW_H
    const mid = y0 + ROW_H / 2

    ctx.fillStyle = row % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.2)'
    ctx.fillRect(0, y0, cssW, ROW_H)

    const label = syncLabel(s)
    ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    const line1 = label.length > 16 ? `${label.slice(0, 15)}…` : label
    ctx.fillText(line1, 4, mid - 6)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(syncKindLabel(s.kind), 4, mid + 8)

    // Mutex hold strips
    for (const h of s.holdSegs) {
      if (h.end < view0 || h.start > view1) continue
      const x0 = xOf(Math.max(h.start, view0))
      const x1 = xOf(Math.min(h.end, view1))
      const w = Math.max(1, x1 - x0)
      const hy = mid - HOLD_H / 2
      ctx.fillStyle = ownerFill(h.ownerId)
      ctx.fillRect(x0, hy, w, HOLD_H)
      if (h.inversion) {
        ctx.strokeStyle = COL_INV_STROKE
        ctx.lineWidth = 1.5
        ctx.strokeRect(x0 + 0.5, hy + 0.5, w - 1, HOLD_H - 1)
      }
    }

    // Semaphore count step line
    if (s.kind === 'sem' && s.countSamples.length > 0) {
      const plotTop = y0 + 10
      const plotH = ROW_H - 18
      ctx.strokeStyle = COL_COUNT
      ctx.lineWidth = 1.25
      ctx.beginPath()
      let started = false
      const drawAt = (ts: number, count: number) => {
        const x = xOf(ts)
        const y = plotTop + (1 - count / peakCount) * plotH
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      drawAt(view0, syncCountAt(s.countSamples, view0))
      for (const c of s.countSamples) {
        if (c.ts <= view0 || c.ts > view1) continue
        // Step-after: horizontal then vertical.
        const prevY = plotTop + (1 - syncCountAt(s.countSamples, c.ts - 1) / peakCount) * plotH
        const x = xOf(c.ts)
        if (started) ctx.lineTo(x, prevY)
        drawAt(c.ts, c.count)
      }
      drawAt(view1, syncCountAt(s.countSamples, view1))
      if (started) ctx.stroke()
    }

    // Wait segments (thin under-band)
    for (const w of s.waitSegs) {
      if (w.end < view0 || w.start > view1) continue
      const x0 = xOf(Math.max(w.start, view0))
      const x1 = xOf(Math.min(w.end, view1))
      ctx.fillStyle = w.inversion ? COL_WAIT_INV : COL_WAIT
      ctx.fillRect(x0, mid + WAIT_Y, Math.max(1, x1 - x0), 3)
    }

    // Handoff ticks
    for (const h of s.handoffs) {
      if (h.ts < view0 || h.ts > view1) continue
      const x = xOf(h.ts)
      ctx.strokeStyle = COL_HANDOFF
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, mid - HOLD_H / 2 - 4)
      ctx.lineTo(x, mid + HOLD_H / 2 + 6)
      ctx.stroke()
      // Small chevron pointing right (claim direction).
      ctx.beginPath()
      ctx.moveTo(x, mid - HOLD_H / 2 - 4)
      ctx.lineTo(x + 3, mid - HOLD_H / 2 - 1)
      ctx.lineTo(x, mid - HOLD_H / 2 + 2)
      ctx.stroke()
    }

    // Op marks (dots)
    for (const m of s.marks) {
      if (m.ts < view0 || m.ts > view1) continue
      if (m.blocking) continue // wait strip already shows blocking
      const x = xOf(m.ts)
      ctx.fillStyle = !m.ok ? COL_ERR : COL_MARK
      ctx.beginPath()
      ctx.arc(x, mid - HOLD_H / 2 - 1, 2, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)'
    ctx.beginPath()
    ctx.moveTo(LABEL_W, y0 + ROW_H - 0.5)
    ctx.lineTo(LABEL_W + plotW, y0 + ROW_H - 0.5)
    ctx.stroke()
  })

  ctx.restore()
  canvas.style.height = `${cssH}px`
}

type HoverTip = {
  x: number
  y: number
  ts: number
  series: SyncSeries
  mark: SyncMark
}

function tipLines(tr: Trace, tip: HoverTip): string[] {
  const { series: s, mark: m } = tip
  const lines = [
    syncLabel(s),
    `${syncOpLabel(m.op, m.blocking)}${m.ok ? '' : ' (failed)'}`,
    formatGuestTime(m.ts, 1_000),
  ]
  if (m.threadId != null) {
    lines.push(`thread ${threadLabel(tr, m.threadId)}`)
  }
  if (m.ownerId != null) {
    lines.push(`owner ${threadLabel(tr, m.ownerId)}`)
  } else if (s.kind === 'sem' && m.value != null) {
    lines.push(`count ${m.value}`)
  }
  if (m.inversion) lines.push('priority inversion')
  return lines
}

export function SyncView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  nameById,
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
  nameById?: Map<number, string> | null
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
  overlay?: ReactNode
  boxZoomArmed?: boolean
  yZoom?: YZoom | null
}) {
  const series = useMemo(
    () => reconstructSync(tr, nameById),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount, nameById],
  )
  const stats = useMemo(() => syncWindowStats(series, view0, view1), [series, view0, view1])
  const seriesRef = useRef(series)
  const yZoomRef = useRef(yZoom)
  seriesRef.current = series
  yZoomRef.current = yZoom
  const [tip, setTip] = useState<HoverTip | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, tr, series, view0, view1, follow, yZoom)
  }, [tr, series, view0, view1, follow, canvasRef, yZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(canvas, tr, seriesRef.current, view0, view1, follow, yZoomRef.current)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, canvasRef])

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    canvasProps?.onPointerMove?.(e)
    if (boxZoomArmed || e.buttons !== 0) {
      if (tip) setTip(null)
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (x < LABEL_W || y < AXIS_H) {
      if (tip) setTip(null)
      return
    }
    const plotW = Math.max(1, rect.width - LABEL_W - PAD)
    const span = Math.max(1, view1 - view0)
    const ts = view0 + ((x - LABEL_W) / plotW) * span
    const maxDeltaNs = (SNAP_PX / plotW) * span
    const hit = nearestSyncMark(seriesRef.current, ts, maxDeltaNs)
    if (!hit) {
      if (tip) setTip(null)
      return
    }
    setTip({ x, y, ts: hit.mark.ts, series: hit.series, mark: hit.mark })
  }

  const onLeave = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    canvasProps?.onPointerLeave?.(e)
    if (tip) setTip(null)
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span>
          objects <span className="font-mono text-foreground">{stats.objects}</span>
        </span>
        <span>
          holds <span className="font-mono text-foreground">{stats.holds}</span>
        </span>
        <span>
          waits <span className="font-mono text-amber-400/90">{stats.waits}</span>
        </span>
        <span>
          handoffs <span className="font-mono text-emerald-400/90">{stats.handoffs}</span>
        </span>
        <span>
          inversions <span className="font-mono text-rose-400/90">{stats.inversions}</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1" title="Thread holding a mutex">
            <i className="inline-block h-1.5 w-3 rounded-sm bg-teal-400/80" />
            hold
          </span>
          <span className="inline-flex items-center gap-1" title="Thread waiting on the object">
            <i className="inline-block h-0.5 w-3 rounded-sm bg-amber-400" />
            wait
          </span>
          <span
            className="inline-flex items-center gap-1"
            title="Unlock or give that passes the object to a waiter"
          >
            <i className="inline-block h-2.5 w-0.5 bg-emerald-300" />
            handoff
          </span>
          <span
            className="inline-flex items-center gap-1"
            title="Higher-priority thread waiting behind a lower-priority owner"
          >
            <i className="inline-block size-1.5 rounded-sm ring-1 ring-rose-400 bg-transparent" />
            inversion
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
          onPointerMove={onMove}
          onPointerLeave={onLeave}
        />
        {overlay}
        {tip && (
          <div
            className="pointer-events-none absolute z-10 max-w-[16rem] rounded border border-border/70 bg-popover px-2 py-1.5 text-[10px] leading-snug text-popover-foreground shadow-md"
            style={{
              left: Math.min(tip.x + 12, (canvasRef.current?.clientWidth ?? 0) - 8),
              top: Math.max(4, tip.y - 8),
              transform: 'translateY(-100%)',
            }}
          >
            {tipLines(tr, tip).map((line, i) => (
              <div key={i} className={i === 0 ? 'font-medium text-foreground' : 'text-muted-foreground'}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const SYNC_LABEL_W = LABEL_W
