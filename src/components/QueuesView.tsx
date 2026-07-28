/**
 * Stacked msgq depth charts — depth replayed from put_exit / get_exit alone.
 * Shares the Trace panel's time window (follow / pan / zoom).
 */

import { useEffect, useMemo, useRef, type CanvasHTMLAttributes, type RefObject } from 'react'
import {
  depthAt,
  fmtTime,
  niceTimeStep,
  queueAxisMax,
  queueLabel,
  reconstructQueues,
  type QueueSeries,
  type Trace,
} from '@/ctf'
import { getWaitObjects } from '@/hostGdb'
import { QueueGraph } from '@/components/QueueGraph'

const LABEL_W = 108
const PAD = 8
const AXIS_H = 28
const ROW_H = 72
const PLOT_PAD_TOP = 14
const PLOT_PAD_BOT = 6

function msgqNameMap(): Map<number, string> {
  const map = new Map<number, string>()
  for (const o of getWaitObjects()) {
    if (o.kind === 'msgq' || o.name.toLowerCase().includes('msgq') || o.name.startsWith('q_')) {
      map.set(o.addr, o.name)
    }
  }
  // Also accept any exact-address wait object when the CTF id matches.
  for (const o of getWaitObjects()) {
    if (!map.has(o.addr)) map.set(o.addr, o.name)
  }
  return map
}

function paint(
  canvas: HTMLCanvasElement,
  tr: Trace,
  queues: QueueSeries[],
  view0: number,
  view1: number,
  follow: boolean,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const rows = Math.max(1, queues.length)
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

  // Shared time-axis (same idiom as Schedule).
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
    const x = LABEL_W + ((t - view0) / span) * plotW
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = fmtTime(t - tr.t0)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  const leftLbl = fmtTime(view0 - tr.t0)
  const rightLbl = fmtTime(view1 - tr.t0)
  ctx.fillText(leftLbl, LABEL_W, 26)
  ctx.fillText(rightLbl, LABEL_W + plotW - ctx.measureText(rightLbl).width, 26)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  if (queues.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No msgq put/get exits in this trace yet.', LABEL_W, AXIS_H + 28)
    canvas.style.height = `${cssH}px`
    return
  }

  const cols = Math.max(64, Math.floor(plotW))
  const colW = plotW / cols

  queues.forEach((q, row) => {
    const y0 = AXIS_H + row * ROW_H
    const plotTop = y0 + PLOT_PAD_TOP
    const plotH = ROW_H - PLOT_PAD_TOP - PLOT_PAD_BOT
    const yMax = queueAxisMax(q)

    // Row background.
    ctx.fillStyle = row % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.2)'
    ctx.fillRect(0, y0, cssW, ROW_H)

    // Label + drops.
    const name = queueLabel(q)
    ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'alphabetic'
    const trimmed = name.length > 12 ? `${name.slice(0, 11)}…` : name
    ctx.fillText(trimmed, 4, y0 + 14)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(`${q.drops} drop${q.drops === 1 ? '' : 's'}`, 4, y0 + 28)

    // Y ticks (0 and max).
    ctx.fillStyle = 'rgba(100, 116, 139, 0.9)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(yMax), 4, plotTop + 2)
    ctx.fillText('0', 4, plotTop + plotH)

    // Cap line.
    if (q.cap != null && q.cap > 0) {
      const cy = plotTop + (1 - q.cap / yMax) * plotH
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.75)'
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(LABEL_W, cy)
      ctx.lineTo(LABEL_W + plotW, cy)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(244, 63, 94, 0.85)'
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'bottom'
      const capLbl = `cap=${q.cap}`
      ctx.fillText(capLbl, LABEL_W + plotW - ctx.measureText(capLbl).width - 2, cy - 1)
    }

    // Depth step area (columnized for speed, like Schedule state rows).
    ctx.beginPath()
    let started = false
    for (let c = 0; c < cols; c++) {
      const t = view0 + ((c + 0.5) / cols) * span
      const d = depthAt(q.samples, t)
      const x = LABEL_W + c * colW
      const y = plotTop + (1 - d / yMax) * plotH
      if (!started) {
        ctx.moveTo(x, plotTop + plotH)
        ctx.lineTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    ctx.lineTo(LABEL_W + plotW, plotTop + plotH)
    ctx.closePath()
    ctx.fillStyle = 'rgba(96, 165, 250, 0.35)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(147, 197, 253, 0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let c = 0; c < cols; c++) {
      const t = view0 + ((c + 0.5) / cols) * span
      const d = depthAt(q.samples, t)
      const x = LABEL_W + c * colW + colW / 2
      const y = plotTop + (1 - d / yMax) * plotH
      if (c === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Baseline.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
    ctx.beginPath()
    ctx.moveTo(LABEL_W, plotTop + plotH)
    ctx.lineTo(LABEL_W + plotW, plotTop + plotH)
    ctx.stroke()
  })

  canvas.style.height = `${cssH}px`
}

export function QueuesView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  canvasRef,
  canvasProps,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
}) {
  const queues = useMemo(
    () => reconstructQueues(tr, msgqNameMap()),
    // eventCount bumps when CTF grows; wait-object names are read live inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const queuesRef = useRef(queues)
  queuesRef.current = queues

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, tr, queues, view0, view1, follow)
  }, [tr, queues, view0, view1, follow, canvasRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(canvas, tr, queuesRef.current, view0, view1, follow)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, canvasRef])

  return (
    <>
      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        Thread ↔ msgq flow from <span className="font-mono text-foreground/80">put_exit</span> /{' '}
        <span className="font-mono text-foreground/80">get_exit</span>
        {queues.length > 0 ? ` · ${queues.length} msgq` : ''}
        . Packets animate on new traffic; depth charts share the Schedule window below.
      </p>
      {queues.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-sky-400" /> put →
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-amber-400" /> ← get
          </span>
          <span>depth fill · dashed cap</span>
        </div>
      )}
      {queues.length > 0 && <QueueGraph tr={tr} queues={queues} eventCount={eventCount} />}
      <canvas
        ref={canvasRef}
        className="w-full cursor-grab touch-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
        {...canvasProps}
      />
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const QUEUES_LABEL_W = LABEL_W
export const QUEUES_PAD = PAD
