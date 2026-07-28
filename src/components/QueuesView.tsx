/**
 * Message-queue depth history chart — depth replayed from put/get/purge exits.
 *
 * Shares the Trace panel's time window (follow / pan / zoom). Hover shows a
 * crosshair plus a tip with timestamp, depth, and the nearest msgq CTF event.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CanvasHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  depthAt,
  flowThreadLabel,
  fmtTime,
  nearestQueueChartEvent,
  niceTimeStep,
  queueAxisMax,
  queueChartEvents,
  queueChartOpLabel,
  queueLabel,
  reconstructQueues,
  sortQueuesByPipelineOrder,
  type QueueChartEvent,
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
/** Snap hover to an event when it lands within this many plot pixels. */
const SNAP_PX = 10

type HoverTip = {
  /** Canvas-relative tip anchor (plot x, row midline). */
  x: number
  y: number
  /** Absolute CTF timestamp under the cursor (after snap). */
  ts: number
  queue: QueueSeries
  depth: number
  event: QueueChartEvent | null
}

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
  hover: HoverTip | null,
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

    // Hover depth marker on the active row.
    if (hover && hover.queue.id === q.id) {
      const dy = plotTop + (1 - hover.depth / yMax) * plotH
      ctx.fillStyle = 'rgba(250, 250, 250, 0.95)'
      ctx.beginPath()
      ctx.arc(hover.x, dy, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  })

  // Shared vertical crosshair across all rows.
  if (hover && hover.x >= LABEL_W && hover.x <= LABEL_W + plotW) {
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hover.x, AXIS_H)
    ctx.lineTo(hover.x, AXIS_H + queues.length * ROW_H)
    ctx.stroke()
    ctx.setLineDash([])
  }

  canvas.style.height = `${cssH}px`
}

function tipLines(tr: Trace, tip: HoverTip): string[] {
  const lines = [
    queueLabel(tip.queue),
    `t = ${fmtTime(tip.ts - tr.t0)}`,
    tip.queue.cap != null
      ? `depth ${tip.depth} / cap ${tip.queue.cap}`
      : `depth ${tip.depth}`,
  ]
  if (tip.event) {
    const who =
      tip.event.threadId != null ? flowThreadLabel(tr, tip.event.threadId) : 'unknown thread'
    const outcome = tip.event.op === 'purge' ? '' : tip.event.ok ? ' · ok' : ' · failed'
    lines.push(`${queueChartOpLabel(tip.event.op)}${outcome}`)
    lines.push(`by ${who}`)
    if (tip.event.ts !== tip.ts) {
      lines.push(`event @ ${fmtTime(tip.event.ts - tr.t0)}`)
    }
  }
  return lines
}

/**
 * Interactive msgq depth-over-time chart. Canvas paint stays fast for live
 * follow; hover tip is an HTML overlay so timestamps stay selectable/readable.
 */
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
    () => sortQueuesByPipelineOrder(tr, reconstructQueues(tr, msgqNameMap())),
    // eventCount bumps when CTF grows; wait-object names are read live inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const chartEvents = useMemo(
    () => queueChartEvents(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const queuesRef = useRef(queues)
  queuesRef.current = queues
  const eventsRef = useRef(chartEvents)
  eventsRef.current = chartEvents
  const viewRef = useRef({ view0, view1 })
  viewRef.current = { view0, view1 }

  const [hover, setHover] = useState<HoverTip | null>(null)
  const hoverRef = useRef<HoverTip | null>(null)
  hoverRef.current = hover

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, tr, queues, view0, view1, follow, hover)
  }, [tr, queues, view0, view1, follow, canvasRef, hover])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(canvas, tr, queuesRef.current, view0, view1, follow, hoverRef.current)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, canvasRef])

  const resolveHover = useCallback(
    (clientX: number, clientY: number, target: HTMLCanvasElement): HoverTip | null => {
      const rect = target.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      const qs = queuesRef.current
      if (qs.length === 0) return null
      const { view0: v0, view1: v1 } = viewRef.current
      const plotW = Math.max(1, target.clientWidth - LABEL_W - PAD)
      if (x < LABEL_W || x > LABEL_W + plotW || y < AXIS_H) return null
      const row = Math.floor((y - AXIS_H) / ROW_H)
      if (row < 0 || row >= qs.length) return null
      const q = qs[row]!
      const span = Math.max(1, v1 - v0)
      let ts = v0 + ((x - LABEL_W) / plotW) * span
      const snapDelta = (SNAP_PX / plotW) * span
      // Wider window for tip copy so sparse traces still name an event.
      const infoDelta = Math.max(snapDelta, span * 0.03)
      const snapEvent = nearestQueueChartEvent(eventsRef.current, q.id, ts, snapDelta)
      const event =
        snapEvent ?? nearestQueueChartEvent(eventsRef.current, q.id, ts, infoDelta)
      if (snapEvent) ts = snapEvent.ts
      const plotX = LABEL_W + ((ts - v0) / span) * plotW
      return {
        x: plotX,
        y: AXIS_H + row * ROW_H + ROW_H / 2,
        ts,
        queue: q,
        depth: depthAt(q.samples, ts),
        event,
      }
    },
    [],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      canvasProps?.onPointerMove?.(e)
      // Skip tip while dragging (pan) — buttons !== 0.
      if (e.buttons !== 0) {
        if (hoverRef.current) setHover(null)
        return
      }
      setHover(resolveHover(e.clientX, e.clientY, e.currentTarget))
    },
    [canvasProps, resolveHover],
  )

  const onPointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      canvasProps?.onPointerLeave?.(e)
      setHover(null)
    },
    [canvasProps],
  )

  const tip = hover ? tipLines(tr, hover) : null
  // Keep the HTML tip inside the chart; flip left of the crosshair near the right edge.
  const tipStyle =
    hover && tip
      ? {
          left: hover.x > LABEL_W + 180 ? hover.x - 12 : hover.x + 12,
          top: Math.max(AXIS_H + 4, hover.y - 28),
          transform: hover.x > LABEL_W + 180 ? 'translateX(-100%)' : undefined,
        }
      : undefined

  return (
    <>
      {queues.length > 0 && <QueueGraph tr={tr} queues={queues} eventCount={eventCount} />}
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full cursor-crosshair touch-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
          {...canvasProps}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        />
        {tip && tipStyle && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 max-w-[16rem] rounded border border-border/70 bg-background/95 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground shadow-md backdrop-blur-sm"
            style={tipStyle}
          >
            {tip.map((line, i) => (
              <div
                key={i}
                className={i === 0 ? 'text-foreground' : 'text-muted-foreground'}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
      {queues.length > 0 && (
        <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
          Hover a depth trace for timestamp and nearest msgq event · drag to pan · pinch or ± to
          zoom
        </p>
      )}
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const QUEUES_LABEL_W = LABEL_W
export const QUEUES_PAD = PAD
