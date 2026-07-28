/**
 * Message-queue depth history chart — depth replayed from put/get/purge exits.
 *
 * Shares the Trace panel's time window (follow / pan / zoom). Uses d3 scales
 * for time/depth mapping and a bottom d3 axisBottom for a precise time ruler.
 * Hover shows a crosshair plus a tip with timestamp, depth, and nearest event.
 */

import * as d3 from 'd3'
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
  fmtAxisTime,
  nearestQueueChartEvent,
  queueAxisMax,
  queueChartEvents,
  queueChartOpLabel,
  queueLabel,
  reconstructQueues,
  sortQueuesByPipelineOrder,
  timeTickValues,
  type QueueChartEvent,
  type QueueSeries,
  type Trace,
} from '@/ctf'
import { getWaitObjects } from '@/hostGdb'
import { QueueGraph } from '@/components/QueueGraph'

const LABEL_W = 108
const PAD = 8
/** Slim top strip for the LIVE badge — time ticks live on the bottom axis. */
const TOP_H = 16
const BOTTOM_AXIS_H = 36
const ROW_H = 72
const PLOT_PAD_TOP = 14
const PLOT_PAD_BOT = 6
/** Snap hover to an event when it lands within this many plot pixels. */
const SNAP_PX = 10

const AXIS_STROKE = 'rgba(148, 163, 184, 0.55)'
const AXIS_FILL = 'rgba(203, 213, 225, 0.95)'
const GRID_STROKE = 'rgba(148, 163, 184, 0.12)'

type HoverTip = {
  /** Canvas-relative tip anchor (plot x, row midline). */
  x: number
  y: number
  /** Absolute CTF timestamp under the cursor (after snap). */
  ts: number
  /** Tick step used for precise time formatting. */
  step: number
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
  for (const o of getWaitObjects()) {
    if (!map.has(o.addr)) map.set(o.addr, o.name)
  }
  return map
}

function depthTicks(yMax: number): number[] {
  if (yMax <= 0) return [0]
  if (yMax <= 4) return d3.range(0, yMax + 1)
  const ticks = d3.ticks(0, yMax, 3).map((t) => Math.round(t))
  return [...new Set([0, ...ticks, yMax])].sort((a, b) => a - b)
}

function chartHeight(rows: number): number {
  return Math.max(TOP_H + ROW_H + BOTTOM_AXIS_H, TOP_H + rows * ROW_H + BOTTOM_AXIS_H)
}

function paint(
  canvas: HTMLCanvasElement,
  queues: QueueSeries[],
  view0: number,
  view1: number,
  follow: boolean,
  hover: HoverTip | null,
  tickValues: number[],
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const rows = Math.max(1, queues.length)
  const cssH = chartHeight(rows)
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const plotW = Math.max(1, cssW - LABEL_W - PAD)
  const xScale = d3.scaleLinear().domain([view0, view1]).range([LABEL_W, LABEL_W + plotW])
  const plotBottom = TOP_H + rows * ROW_H

  // LIVE badge only — precise ticks are on the bottom d3 axis.
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  } else {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('t →', 4, 12)
  }

  // Axis gutter background (SVG ticks draw on top).
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(0, plotBottom, cssW, BOTTOM_AXIS_H)

  if (queues.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No msgq put/get exits in this trace yet.', LABEL_W, TOP_H + 28)
    canvas.style.height = `${cssH}px`
    return
  }

  // Vertical grid at major time ticks (shared across rows).
  ctx.strokeStyle = GRID_STROKE
  ctx.lineWidth = 1
  for (const t of tickValues) {
    const x = xScale(t)
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, TOP_H)
    ctx.lineTo(x, plotBottom)
    ctx.stroke()
  }

  const cols = Math.max(64, Math.floor(plotW))
  const colW = plotW / cols
  const span = Math.max(1, view1 - view0)

  queues.forEach((q, row) => {
    const y0 = TOP_H + row * ROW_H
    const plotTop = y0 + PLOT_PAD_TOP
    const plotH = ROW_H - PLOT_PAD_TOP - PLOT_PAD_BOT
    const yMax = queueAxisMax(q)
    const yScale = d3.scaleLinear().domain([0, yMax]).range([plotTop + plotH, plotTop])

    ctx.fillStyle = row % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.2)'
    ctx.fillRect(0, y0, cssW, ROW_H)

    const name = queueLabel(q)
    ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'alphabetic'
    const trimmed = name.length > 12 ? `${name.slice(0, 11)}…` : name
    ctx.fillText(trimmed, 4, y0 + 14)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(`${q.drops} drop${q.drops === 1 ? '' : 's'}`, 4, y0 + 28)

    ctx.fillStyle = 'rgba(100, 116, 139, 0.9)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    for (const d of depthTicks(yMax)) {
      ctx.fillText(String(d), 4, yScale(d))
    }

    if (q.cap != null && q.cap > 0) {
      const cy = yScale(q.cap)
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

    ctx.beginPath()
    let started = false
    for (let c = 0; c < cols; c++) {
      const t = view0 + ((c + 0.5) / cols) * span
      const d = depthAt(q.samples, t)
      const x = LABEL_W + c * colW
      const y = yScale(d)
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
      const y = yScale(d)
      if (c === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)'
    ctx.beginPath()
    ctx.moveTo(LABEL_W, plotTop + plotH)
    ctx.lineTo(LABEL_W + plotW, plotTop + plotH)
    ctx.stroke()

    if (hover && hover.queue.id === q.id) {
      const dy = yScale(hover.depth)
      ctx.fillStyle = 'rgba(250, 250, 250, 0.95)'
      ctx.beginPath()
      ctx.arc(hover.x, dy, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  })

  if (hover && hover.x >= LABEL_W && hover.x <= LABEL_W + plotW) {
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.55)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hover.x, TOP_H)
    ctx.lineTo(hover.x, plotBottom)
    ctx.stroke()
    ctx.setLineDash([])
  }

  canvas.style.height = `${cssH}px`
}

function paintTimeAxis(
  svg: SVGSVGElement,
  tr: Trace,
  view0: number,
  view1: number,
  cssW: number,
  plotBottom: number,
  tickValues: number[],
  step: number,
) {
  const plotW = Math.max(1, cssW - LABEL_W - PAD)
  const xScale = d3.scaleLinear().domain([view0, view1]).range([LABEL_W, LABEL_W + plotW])

  const root = d3.select(svg)
  root.selectAll('*').remove()
  root
    .attr('width', cssW)
    .attr('height', BOTTOM_AXIS_H)
    .attr('viewBox', `0 0 ${cssW} ${BOTTOM_AXIS_H}`)
    .style('top', `${plotBottom}px`)

  const axis = d3
    .axisBottom(xScale)
    .tickValues(tickValues)
    .tickSizeOuter(0)
    .tickSizeInner(6)
    .tickPadding(6)
    .tickFormat((d) => fmtAxisTime(Number(d) - tr.t0, step))

  const g = root.append('g').attr('transform', 'translate(0,4)').call(axis)

  g.select('.domain').attr('stroke', AXIS_STROKE).attr('stroke-width', 1)
  g.selectAll('.tick line').attr('stroke', AXIS_STROKE)
  g.selectAll('.tick text')
    .attr('fill', AXIS_FILL)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .attr('font-size', '10px')

  // Exact window edges under the tick row.
  root
    .append('text')
    .attr('x', LABEL_W)
    .attr('y', BOTTOM_AXIS_H - 2)
    .attr('fill', 'rgba(148, 163, 184, 0.85)')
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .attr('font-size', '9px')
    .attr('text-anchor', 'start')
    .text(fmtAxisTime(view0 - tr.t0, step))

  root
    .append('text')
    .attr('x', LABEL_W + plotW)
    .attr('y', BOTTOM_AXIS_H - 2)
    .attr('fill', 'rgba(148, 163, 184, 0.85)')
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .attr('font-size', '9px')
    .attr('text-anchor', 'end')
    .text(fmtAxisTime(view1 - tr.t0, step))
}

function tipLines(tr: Trace, tip: HoverTip): string[] {
  const lines = [
    queueLabel(tip.queue),
    `t = ${fmtAxisTime(tip.ts - tr.t0, Math.max(1, tip.step / 10))}`,
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
      lines.push(`event @ ${fmtAxisTime(tip.event.ts - tr.t0, Math.max(1, tip.step / 10))}`)
    }
  }
  return lines
}

/**
 * Interactive msgq depth-over-time chart. Canvas paints the series; d3 owns the
 * bottom time axis and the x/y scales used for grid + hover mapping.
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
  const axisRef = useRef<SVGSVGElement | null>(null)
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

  const ticksForWidth = useCallback(
    (plotW: number) => {
      // Denser than Schedule (~72px) so the bottom axis reads as a precise ruler.
      return timeTickValues(view0, view1, Math.max(4, Math.floor(plotW / 56)))
    },
    [view0, view1],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const axis = axisRef.current
    if (!canvas) return
    const cssW = Math.max(1, canvas.clientWidth)
    const plotW = Math.max(1, cssW - LABEL_W - PAD)
    const { values, step } = ticksForWidth(plotW)
    const rows = Math.max(1, queues.length)
    paint(canvas, queues, view0, view1, follow, hover, values)
    if (axis) paintTimeAxis(axis, tr, view0, view1, cssW, TOP_H + rows * ROW_H, values, step)
  }, [tr, queues, view0, view1, follow, canvasRef, hover, ticksForWidth])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const cssW = Math.max(1, canvas.clientWidth)
      const plotW = Math.max(1, cssW - LABEL_W - PAD)
      const { values, step } = ticksForWidth(plotW)
      const rows = Math.max(1, queuesRef.current.length)
      paint(canvas, queuesRef.current, view0, view1, follow, hoverRef.current, values)
      if (axisRef.current) {
        paintTimeAxis(axisRef.current, tr, view0, view1, cssW, TOP_H + rows * ROW_H, values, step)
      }
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, canvasRef, ticksForWidth])

  const resolveHover = useCallback(
    (clientX: number, clientY: number, target: HTMLCanvasElement): HoverTip | null => {
      const rect = target.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      const qs = queuesRef.current
      if (qs.length === 0) return null
      const { view0: v0, view1: v1 } = viewRef.current
      const plotW = Math.max(1, target.clientWidth - LABEL_W - PAD)
      const xScale = d3.scaleLinear().domain([v0, v1]).range([LABEL_W, LABEL_W + plotW])
      const plotBottom = TOP_H + qs.length * ROW_H
      if (x < LABEL_W || x > LABEL_W + plotW || y < TOP_H || y >= plotBottom) return null
      const row = Math.floor((y - TOP_H) / ROW_H)
      if (row < 0 || row >= qs.length) return null
      const q = qs[row]!
      const span = Math.max(1, v1 - v0)
      const { step } = timeTickValues(v0, v1, Math.max(4, Math.floor(plotW / 56)))
      let ts = xScale.invert(x)
      const snapDelta = (SNAP_PX / plotW) * span
      const infoDelta = Math.max(snapDelta, span * 0.03)
      const snapEvent = nearestQueueChartEvent(eventsRef.current, q.id, ts, snapDelta)
      const event =
        snapEvent ?? nearestQueueChartEvent(eventsRef.current, q.id, ts, infoDelta)
      if (snapEvent) ts = snapEvent.ts
      return {
        x: xScale(ts),
        y: TOP_H + row * ROW_H + ROW_H / 2,
        ts,
        step,
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
  const tipStyle =
    hover && tip
      ? {
          left: hover.x > LABEL_W + 180 ? hover.x - 12 : hover.x + 12,
          top: Math.max(TOP_H + 4, hover.y - 28),
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
        <svg
          ref={axisRef}
          className="pointer-events-none absolute left-0 w-full"
          aria-hidden
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
