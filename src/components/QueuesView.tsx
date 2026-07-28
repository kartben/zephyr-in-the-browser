/**
 * Message-queue depth history chart — depth replayed from put/get/purge exits.
 *
 * Full d3 SVG chart (scales, area/line series, axes). Shares the Trace panel's
 * time window (follow / pan / zoom). Transition dots mark depth changes; hover
 * a dot for a short tip (time, depth, op, thread).
 */

import * as d3 from 'd3'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SVGAttributes,
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
  type QueueSample,
  type QueueSeries,
  type Trace,
} from '@/ctf'
import { getWaitObjects } from '@/hostGdb'
import { QueueGraph } from '@/components/QueueGraph'
import { formatTraceTimes } from '@/components/traceChart'

const LABEL_W = 108
const PAD = 8
const TOP_H = 16
const BOTTOM_AXIS_H = 36
const ROW_H = 72
const PLOT_PAD_TOP = 14
const PLOT_PAD_BOT = 6
/** Only tip when the pointer is this close to a transition dot. */
const SNAP_PX = 10

const AXIS_STROKE = 'rgba(148, 163, 184, 0.55)'
const AXIS_FILL = 'rgba(203, 213, 225, 0.95)'
const GRID_STROKE = 'rgba(148, 163, 184, 0.14)'
const AREA_FILL = 'rgba(96, 165, 250, 0.35)'
const LINE_STROKE = 'rgba(147, 197, 253, 0.95)'
const CAP_STROKE = 'rgba(244, 63, 94, 0.75)'
const DOT_FILL = 'rgba(226, 232, 240, 0.95)'
const DOT_STROKE = 'rgba(59, 130, 246, 0.95)'

type TransitionMark = {
  ts: number
  depth: number
  event: QueueChartEvent | null
}

type HoverTip = {
  x: number
  y: number
  ts: number
  step: number
  queue: QueueSeries
  depth: number
  event: QueueChartEvent | null
}

type RowLayout = {
  queue: QueueSeries
  y0: number
  plotTop: number
  plotH: number
  yMax: number
  yScale: d3.ScaleLinear<number, number>
  points: QueueSample[]
  marks: TransitionMark[]
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

/** Step series clipped to the visible window for d3.curveStepAfter. */
function windowPoints(q: QueueSeries, view0: number, view1: number): QueueSample[] {
  const pts: QueueSample[] = [{ ts: view0, depth: depthAt(q.samples, view0) }]
  for (const s of q.samples) {
    if (s.ts <= view0 || s.ts > view1) continue
    pts.push(s)
  }
  const last = pts[pts.length - 1]!
  if (last.ts < view1) pts.push({ ts: view1, depth: last.depth })
  return pts
}

/** Real depth-change samples inside the window (not synthetic edges). */
function transitionMarks(
  q: QueueSeries,
  events: QueueChartEvent[],
  view0: number,
  view1: number,
): TransitionMark[] {
  const marks: TransitionMark[] = []
  for (const s of q.samples) {
    if (s.ts < view0 || s.ts > view1) continue
    // Exact CTF exit at this sample, else null (still a depth transition).
    const event = nearestQueueChartEvent(events, q.id, s.ts, 0)
    marks.push({ ts: s.ts, depth: s.depth, event })
  }
  return marks
}

function nearestMark(marks: TransitionMark[], ts: number, maxDeltaNs: number): TransitionMark | null {
  if (marks.length === 0 || maxDeltaNs < 0) return null
  let lo = 0
  let hi = marks.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (marks[mid]!.ts < ts) lo = mid + 1
    else hi = mid
  }
  let best: TransitionMark | null = null
  let bestDelta = maxDeltaNs
  for (const i of [lo, lo - 1]) {
    const m = marks[i]
    if (!m) continue
    const d = Math.abs(m.ts - ts)
    if (d <= bestDelta) {
      best = m
      bestDelta = d
    }
  }
  return best
}

function styleAxis(g: d3.Selection<SVGGElement, unknown, null, undefined>): void {
  g.select('.domain').attr('stroke', AXIS_STROKE).attr('stroke-width', 1)
  g.selectAll('.tick line').attr('stroke', AXIS_STROKE)
  g.selectAll('.tick text')
    .attr('fill', AXIS_FILL)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .attr('font-size', '10px')
}

function clearDomSelection(): void {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  sel?.removeAllRanges()
}

function renderChart(
  svg: SVGSVGElement,
  tr: Trace,
  queues: QueueSeries[],
  events: QueueChartEvent[],
  view0: number,
  view1: number,
  follow: boolean,
  hover: HoverTip | null,
): RowLayout[] {
  const cssW = Math.max(1, svg.clientWidth || (svg.parentElement?.clientWidth ?? 320))
  const plotBottom = TOP_H + (queues.length === 0 ? ROW_H : queues.length * ROW_H)
  const cssH = plotBottom + BOTTOM_AXIS_H
  const plotW = Math.max(1, cssW - LABEL_W - PAD)
  const xScale = d3.scaleLinear().domain([view0, view1]).range([LABEL_W, LABEL_W + plotW])
  const { values: tickValues, step } = timeTickValues(
    view0,
    view1,
    Math.max(4, Math.floor(plotW / 56)),
  )

  const root = d3.select(svg)
  root
    .attr('width', cssW)
    .attr('height', cssH)
    .attr('viewBox', `0 0 ${cssW} ${cssH}`)
    .attr('role', 'img')
    .attr('aria-label', 'Message queue depth over time')

  let frame = root.select<SVGGElement>('g.frame')
  if (frame.empty()) frame = root.append('g').attr('class', 'frame')

  let bg = frame.select<SVGRectElement>('rect.chart-bg')
  if (bg.empty()) {
    bg = frame.append('rect').attr('class', 'chart-bg').attr('fill', 'rgba(2, 6, 23, 0.35)')
  }
  bg.attr('width', cssW).attr('height', cssH)

  let badge = frame.select<SVGTextElement>('text.live-badge')
  if (badge.empty()) {
    badge = frame
      .append('text')
      .attr('class', 'live-badge')
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .attr('font-size', '10px')
      .attr('y', 12)
  }
  if (follow) {
    badge
      .attr('x', Math.max(LABEL_W, cssW - 32))
      .attr('fill', 'rgba(34, 197, 94, 0.95)')
      .attr('text-anchor', 'start')
      .text('LIVE')
  } else {
    badge.attr('x', 4).attr('fill', 'rgba(148, 163, 184, 0.7)').attr('text-anchor', 'start').text('t →')
  }

  let empty = frame.select<SVGTextElement>('text.empty')
  if (queues.length === 0) {
    if (empty.empty()) {
      empty = frame
        .append('text')
        .attr('class', 'empty')
        .attr('fill', 'rgba(148, 163, 184, 0.8)')
        .attr('font-size', '11px')
        .attr('font-family', 'ui-sans-serif, system-ui, sans-serif')
    }
    empty.attr('x', LABEL_W).attr('y', TOP_H + 28).text('No msgq put/get exits in this trace yet.')
  } else if (!empty.empty()) {
    empty.remove()
  }

  let grid = frame.select<SVGGElement>('g.grid')
  if (grid.empty()) grid = frame.append('g').attr('class', 'grid')
  grid
    .selectAll<SVGLineElement, number>('line')
    .data(queues.length === 0 ? [] : tickValues, (d) => String(d))
    .join('line')
    .attr('x1', (t) => xScale(t))
    .attr('x2', (t) => xScale(t))
    .attr('y1', TOP_H)
    .attr('y2', plotBottom)
    .attr('stroke', GRID_STROKE)
    .attr('stroke-width', 1)

  const layouts: RowLayout[] = queues.map((queue, row) => {
    const y0 = TOP_H + row * ROW_H
    const plotTop = y0 + PLOT_PAD_TOP
    const plotH = ROW_H - PLOT_PAD_TOP - PLOT_PAD_BOT
    const yMax = queueAxisMax(queue)
    const yScale = d3.scaleLinear().domain([0, yMax]).range([plotTop + plotH, plotTop])
    return {
      queue,
      y0,
      plotTop,
      plotH,
      yMax,
      yScale,
      points: windowPoints(queue, view0, view1),
      marks: transitionMarks(queue, events, view0, view1),
    }
  })

  let rowsG = frame.select<SVGGElement>('g.rows')
  if (rowsG.empty()) rowsG = frame.append('g').attr('class', 'rows')

  const rowSel = rowsG
    .selectAll<SVGGElement, RowLayout>('g.row')
    .data(layouts, (d) => String(d.queue.id))
    .join((enter) => {
      const g = enter.append('g').attr('class', 'row')
      g.append('rect').attr('class', 'row-bg')
      g.append('text').attr('class', 'row-name')
      g.append('text').attr('class', 'row-drops')
      g.append('g').attr('class', 'y-axis')
      g.append('line').attr('class', 'cap-line')
      g.append('text').attr('class', 'cap-label')
      g.append('path').attr('class', 'depth-area')
      g.append('path').attr('class', 'depth-line')
      g.append('line').attr('class', 'baseline')
      g.append('g').attr('class', 'marks')
      return g
    })

  rowSel.each(function (d, i) {
    const g = d3.select(this)
    const area = d3
      .area<QueueSample>()
      .x((p) => xScale(p.ts))
      .y0(d.plotTop + d.plotH)
      .y1((p) => d.yScale(p.depth))
      .curve(d3.curveStepAfter)
    const line = d3
      .line<QueueSample>()
      .x((p) => xScale(p.ts))
      .y((p) => d.yScale(p.depth))
      .curve(d3.curveStepAfter)

    g.select<SVGRectElement>('rect.row-bg')
      .attr('x', 0)
      .attr('y', d.y0)
      .attr('width', cssW)
      .attr('height', ROW_H)
      .attr('fill', i % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.2)')

    const name = queueLabel(d.queue)
    const trimmed = name.length > 12 ? `${name.slice(0, 11)}…` : name
    g.select<SVGTextElement>('text.row-name')
      .attr('x', 4)
      .attr('y', d.y0 + 14)
      .attr('fill', 'rgba(226, 232, 240, 0.95)')
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .attr('font-size', '11px')
      .text(trimmed)

    g.select<SVGTextElement>('text.row-drops')
      .attr('x', 4)
      .attr('y', d.y0 + 28)
      .attr('fill', 'rgba(148, 163, 184, 0.85)')
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .attr('font-size', '9px')
      .text(`${d.queue.drops} drop${d.queue.drops === 1 ? '' : 's'}`)

    const yAxis = d3
      .axisLeft(d.yScale)
      .tickValues(depthTicks(d.yMax))
      .tickSize(0)
      .tickPadding(4)
      .tickFormat((v) => String(v))
    const yG = g.select<SVGGElement>('g.y-axis')
    yG.attr('transform', `translate(${LABEL_W},0)`).call(yAxis)
    yG.select('.domain').attr('stroke', 'none')
    yG.selectAll('.tick line').attr('stroke', 'none')
    yG
      .selectAll('.tick text')
      .attr('fill', 'rgba(100, 116, 139, 0.9)')
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .attr('font-size', '9px')
      .attr('text-anchor', 'start')
      .attr('x', -LABEL_W + 4)

    const hasCap = d.queue.cap != null && d.queue.cap > 0
    g.select<SVGLineElement>('line.cap-line')
      .attr('x1', LABEL_W)
      .attr('x2', LABEL_W + plotW)
      .attr('y1', hasCap ? d.yScale(d.queue.cap!) : 0)
      .attr('y2', hasCap ? d.yScale(d.queue.cap!) : 0)
      .attr('stroke', hasCap ? CAP_STROKE : 'none')
      .attr('stroke-dasharray', '4 3')
      .attr('stroke-width', 1)

    g.select<SVGTextElement>('text.cap-label')
      .attr('x', LABEL_W + plotW - 2)
      .attr('y', hasCap ? d.yScale(d.queue.cap!) - 2 : 0)
      .attr('text-anchor', 'end')
      .attr('fill', hasCap ? 'rgba(244, 63, 94, 0.85)' : 'none')
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .attr('font-size', '9px')
      .text(hasCap ? `cap=${d.queue.cap}` : '')

    g.select<SVGPathElement>('path.depth-area')
      .attr('d', area(d.points) ?? '')
      .attr('fill', AREA_FILL)
      .attr('stroke', 'none')

    g.select<SVGPathElement>('path.depth-line')
      .attr('d', line(d.points) ?? '')
      .attr('fill', 'none')
      .attr('stroke', LINE_STROKE)
      .attr('stroke-width', 1.5)
      .attr('stroke-linejoin', 'round')

    g.select<SVGLineElement>('line.baseline')
      .attr('x1', LABEL_W)
      .attr('x2', LABEL_W + plotW)
      .attr('y1', d.plotTop + d.plotH)
      .attr('y2', d.plotTop + d.plotH)
      .attr('stroke', 'rgba(148, 163, 184, 0.25)')
      .attr('stroke-width', 1)

    g.select<SVGGElement>('g.marks')
      .selectAll<SVGCircleElement, TransitionMark>('circle')
      .data(d.marks, (m) => String(m.ts))
      .join('circle')
      .attr('cx', (m) => xScale(m.ts))
      .attr('cy', (m) => d.yScale(m.depth))
      .attr('r', 2.75)
      .attr('fill', DOT_FILL)
      .attr('stroke', DOT_STROKE)
      .attr('stroke-width', 1.25)
  })

  let xAxisG = frame.select<SVGGElement>('g.x-axis')
  if (xAxisG.empty()) xAxisG = frame.append('g').attr('class', 'x-axis')
  const xAxis = d3
    .axisBottom(xScale)
    .tickValues(tickValues)
    .tickSizeOuter(0)
    .tickSizeInner(6)
    .tickPadding(6)
    .tickFormat((t) => fmtAxisTime(Number(t) - tr.t0, step))
  xAxisG.attr('transform', `translate(0,${plotBottom + 4})`).call(xAxis)
  styleAxis(xAxisG)
  // Drop the old edge-left / edge-right clones — ticks already cover the range.
  frame.selectAll('text.edge-left, text.edge-right').remove()

  let hoverG = frame.select<SVGGElement>('g.hover')
  if (hoverG.empty()) {
    hoverG = frame.append('g').attr('class', 'hover').style('pointer-events', 'none')
    hoverG.append('line').attr('class', 'crosshair')
    hoverG.append('circle').attr('class', 'marker')
  }
  if (hover && queues.length > 0) {
    const row = layouts.find((r) => r.queue.id === hover.queue.id)
    hoverG.style('display', null)
    hoverG
      .select('line.crosshair')
      .attr('x1', hover.x)
      .attr('x2', hover.x)
      .attr('y1', TOP_H)
      .attr('y2', plotBottom)
      .attr('stroke', 'rgba(226, 232, 240, 0.55)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3 3')
    if (row) {
      hoverG
        .select('circle.marker')
        .attr('cx', hover.x)
        .attr('cy', row.yScale(hover.depth))
        .attr('r', 4.5)
        .attr('fill', 'rgba(250, 250, 250, 0.98)')
        .attr('stroke', 'rgba(59, 130, 246, 1)')
        .attr('stroke-width', 1.75)
        .style('display', null)
    } else {
      hoverG.select('circle.marker').style('display', 'none')
    }
  } else {
    hoverG.style('display', 'none')
  }

  svg.style.height = `${cssH}px`
  return layouts
}

/** Two-line tip: time · depth, then op · thread (guest abs when it differs). */
function tipLines(tr: Trace, tip: HoverTip): string[] {
  const depth =
    tip.queue.cap != null ? `d${tip.depth}/${tip.queue.cap}` : `d${tip.depth}`
  const { rel, guest } = formatTraceTimes(tip.ts, tr.t0, tip.step)
  const lines = [`${rel} · ${depth}`]
  if (tip.event) {
    const who =
      tip.event.threadId != null ? flowThreadLabel(tr, tip.event.threadId) : '?'
    const fail = tip.event.ok || tip.event.op === 'purge' ? '' : '!'
    lines.push(`${queueChartOpLabel(tip.event.op)}${fail} · ${who}`)
  } else if (guest !== rel) {
    lines.push(`guest ${guest}`)
  }
  return lines
}

/**
 * Interactive msgq depth-over-time chart drawn entirely with d3 (scales, step
 * area/line, axes). Trace pan/zoom handlers attach to the SVG surface.
 */
export function QueuesView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  svgRef,
  surfaceProps,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  svgRef: RefObject<SVGSVGElement | null>
  surfaceProps?: SVGAttributes<SVGSVGElement>
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const layoutsRef = useRef<RowLayout[]>([])

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
    const svg = svgRef.current
    if (!svg) return
    layoutsRef.current = renderChart(
      svg,
      tr,
      queues,
      chartEvents,
      view0,
      view1,
      follow,
      hover,
    )
  }, [tr, queues, chartEvents, view0, view1, follow, svgRef, hover])

  useEffect(() => {
    const host = hostRef.current
    const svg = svgRef.current
    if (!host || !svg || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      layoutsRef.current = renderChart(
        svg,
        tr,
        queuesRef.current,
        eventsRef.current,
        view0,
        view1,
        follow,
        hoverRef.current,
      )
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, svgRef])

  const resolveHover = useCallback(
    (clientX: number, clientY: number, target: SVGSVGElement): HoverTip | null => {
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
      const layout = layoutsRef.current[row]
      const q = qs[row]!
      const span = Math.max(1, v1 - v0)
      const { step } = timeTickValues(v0, v1, Math.max(4, Math.floor(plotW / 56)))
      const ts = xScale.invert(x)
      const marks =
        layout?.marks ?? transitionMarks(q, eventsRef.current, v0, v1)
      const snapDelta = (SNAP_PX / plotW) * span
      const mark = nearestMark(marks, ts, snapDelta)
      // Tips only on transition dots — no “nearest event” while scrubbing flats.
      if (!mark) return null
      return {
        x: xScale(mark.ts),
        y: TOP_H + row * ROW_H + ROW_H / 2,
        ts: mark.ts,
        step,
        queue: q,
        depth: mark.depth,
        event: mark.event,
      }
    },
    [],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      clearDomSelection()
      surfaceProps?.onPointerDown?.(e)
    },
    [surfaceProps],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.buttons !== 0) clearDomSelection()
      surfaceProps?.onPointerMove?.(e)
      if (e.buttons !== 0) {
        if (hoverRef.current) setHover(null)
        return
      }
      setHover(resolveHover(e.clientX, e.clientY, e.currentTarget))
    },
    [surfaceProps, resolveHover],
  )

  const onPointerLeave = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      surfaceProps?.onPointerLeave?.(e)
      setHover(null)
    },
    [surfaceProps],
  )

  const tip = hover ? tipLines(tr, hover) : null
  const tipStyle =
    hover && tip
      ? {
          left: hover.x > LABEL_W + 160 ? hover.x - 10 : hover.x + 10,
          top: Math.max(TOP_H + 4, hover.y - 20),
          transform: hover.x > LABEL_W + 160 ? 'translateX(-100%)' : undefined,
        }
      : undefined

  return (
    <>
      {queues.length > 0 && <QueueGraph tr={tr} queues={queues} eventCount={eventCount} />}
      <div ref={hostRef} className="relative w-full select-none">
        <svg
          ref={svgRef}
          className="block w-full cursor-crosshair touch-none select-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
          {...surfaceProps}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onDragStart={(e) => e.preventDefault()}
        />
        {tip && tipStyle && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 select-none rounded border border-border/70 bg-background/95 px-2 py-1 font-mono text-[10px] leading-snug text-foreground shadow-md backdrop-blur-sm"
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
          Hover a transition · drag to pan · pinch or ± to zoom
        </p>
      )}
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const QUEUES_LABEL_W = LABEL_W
export const QUEUES_PAD = PAD
