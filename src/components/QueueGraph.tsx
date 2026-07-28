/**
 * Per-queue pipe graph for the Trace Queues tab.
 *
 * Each msgq is a horizontal pipe (flanges + barrel + bore fill). Putters sit
 * on the left as name pills, getters on the right. Edges attach to vertically
 * spaced ports on each flange; paths are shortened so arrowheads sit on the
 * mouth without the stroke overshooting the tip.
 *
 * put_front still originates from a putter pill, but the arrow aims at the
 * consumer-side flange (front of the queue), arcing over the pipe.
 */

import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import {
  flowEdgeId,
  flowThreadLabel,
  isPutOp,
  queueFlowEvents,
  type QueueFlowEvent,
  type QueueFlowOp,
} from '@/ctf/queueGraph'
import { queueLabel, type QueueSeries, type Trace } from '@/ctf'
import { fitEllipsis, GRAPH_FONT } from '@/components/queueGraphText'

const HOT_MS = 1200
const WARM_MS = 4200
const MAX_ANIM_PER_TICK = 12

const PILL_W = 112
const PILL_H = 24
const PILL_PAD_X = 10
const PIPE_W = 188
const PIPE_H_MIN = 40
const FLANGE_W = 10
const BORE_INSET = 7
/** Vertical gap between thread pills on the same side. */
const PORT_GAP = 40
const ROW_GAP = 28
const COL_GAP = 48
const PAD_X = 12
const PAD_Y = 10
/** Arrowhead length in user units — path ends this far short of the target. */
const ARROW_LEN = 9
const ARROW_W = 7

const PILL_TEXT_MAX = PILL_W - PILL_PAD_X * 2
const PIPE_TEXT_MAX = PIPE_W - FLANGE_W * 2 - 16

const CLIP_PILL = 'qg-clip-pill'

type ThreadPill = {
  id: string
  tid: number
  label: string
  x: number
  y: number
  /** Side of its pipe. put_front shares the put side. */
  side: 'put' | 'get'
  queueId: number
  port: number
}

type Pipe = {
  id: string
  queueId: number
  label: string
  cap: number
  depth: number
  drops: number
  x: number
  y: number
  h: number
  putPorts: number
  getPorts: number
}

type EdgeState = {
  op: QueueFlowOp
  untilHot: number
  untilWarm: number
  queueId: number
  threadId: number
}

type Layout = {
  w: number
  h: number
  pipes: Pipe[]
  pills: ThreadPill[]
  byPipe: Map<number, Pipe>
  byPill: Map<string, ThreadPill>
}

function pillKey(queueId: number, tid: number, side: 'put' | 'get') {
  return `p:${queueId}:${tid}:${side}`
}

function sideForOp(op: QueueFlowOp): 'put' | 'get' {
  return isPutOp(op) ? 'put' : 'get'
}

function pipeHeight(putPorts: number, getPorts: number): number {
  const n = Math.max(putPorts, getPorts, 1)
  return Math.max(PIPE_H_MIN, Math.min(72, 28 + n * 8))
}

function pipePortY(pipe: Pipe, side: 'put' | 'get', port: number): number {
  const n = side === 'put' ? pipe.putPorts : pipe.getPorts
  const inner = Math.min(14, (pipe.h - 14) / Math.max(1, n - 1 || 1))
  const span = Math.max(0, (n - 1) * inner)
  return pipe.y - span / 2 + port * inner
}

function pillY(pipe: Pipe, port: number, count: number): number {
  const span = Math.max(0, (count - 1) * PORT_GAP)
  return pipe.y - span / 2 + port * PORT_GAP
}

/** Shorten path end so marker tip lands on (x2,y2) instead of stroke overshooting. */
function edgeEndpoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shortenEnd: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const t = Math.max(0.05, (len - shortenEnd) / len)
  return { x1, y1, x2: x1 + dx * t, y2: y1 + dy * t }
}

function edgePath(
  pill: ThreadPill,
  pipe: Pipe,
  op: QueueFlowOp,
): { sx: number; sy: number; ex: number; ey: number; mx: number; my: number; d: string } {
  const sy = pill.y

  // put_front inserts at the front of the queue — aim at the consumer flange.
  if (op === 'put_front') {
    const ey = pipePortY(pipe, 'put', pill.port)
    const raw = edgeEndpoints(pill.x + PILL_W / 2, sy, pipe.x + PIPE_W / 2, ey, ARROW_LEN)
    // Arc over the barrel so the stroke is distinct from a normal put.
    const over = Math.min(raw.y1, raw.y2, pipe.y) - pipe.h / 2 - 14
    const c1x = raw.x1 + (pipe.x - raw.x1) * 0.35
    const c2x = raw.x2 - (raw.x2 - pipe.x) * 0.25
    const mx = (raw.x1 + raw.x2) / 2
    return {
      sx: raw.x1,
      sy: raw.y1,
      ex: raw.x2,
      ey: raw.y2,
      mx,
      my: over,
      d: `M${raw.x1},${raw.y1} C${c1x},${over} ${c2x},${over} ${raw.x2},${raw.y2}`,
    }
  }

  if (op === 'put') {
    const ey = pipePortY(pipe, 'put', pill.port)
    const raw = edgeEndpoints(pill.x + PILL_W / 2, sy, pipe.x - PIPE_W / 2, ey, ARROW_LEN)
    const mx = (raw.x1 + raw.x2) / 2
    return {
      sx: raw.x1,
      sy: raw.y1,
      ex: raw.x2,
      ey: raw.y2,
      mx,
      my: (raw.y1 + raw.y2) / 2,
      d: `M${raw.x1},${raw.y1} C${mx},${raw.y1} ${mx},${raw.y2} ${raw.x2},${raw.y2}`,
    }
  }

  const ey = pipePortY(pipe, 'get', pill.port)
  const raw = edgeEndpoints(pipe.x + PIPE_W / 2, ey, pill.x - PILL_W / 2, sy, ARROW_LEN)
  const mx = (raw.x1 + raw.x2) / 2
  return {
    sx: raw.x1,
    sy: raw.y1,
    ex: raw.x2,
    ey: raw.y2,
    mx,
    my: (raw.y1 + raw.y2) / 2,
    d: `M${raw.x1},${raw.y1} C${mx},${raw.y1} ${mx},${raw.y2} ${raw.x2},${raw.y2}`,
  }
}

function strokeFor(op: QueueFlowOp): string {
  if (op === 'put_front') return '#2dd4bf'
  if (op === 'put') return '#60a5fa'
  return '#fbbf24'
}

function packetFill(op: QueueFlowOp): string {
  if (op === 'put_front') return '#5eead4'
  if (op === 'put') return '#93c5fd'
  return '#fcd34d'
}

function buildLayout(tr: Trace, queues: QueueSeries[], hostW: number): Layout {
  const flow = queueFlowEvents(tr)

  const putters = new Map<number, number[]>()
  const getters = new Map<number, number[]>()
  const seenPut = new Map<number, Set<number>>()
  const seenGet = new Map<number, Set<number>>()
  for (const q of queues) {
    putters.set(q.id, [])
    getters.set(q.id, [])
    seenPut.set(q.id, new Set())
    seenGet.set(q.id, new Set())
  }
  for (const ev of flow) {
    if (!ev.ok || ev.threadId == null) continue
    if (!putters.has(ev.queueId)) continue
    if (isPutOp(ev.op)) {
      const s = seenPut.get(ev.queueId)!
      if (!s.has(ev.threadId)) {
        s.add(ev.threadId)
        putters.get(ev.queueId)!.push(ev.threadId)
      }
    } else {
      const s = seenGet.get(ev.queueId)!
      if (!s.has(ev.threadId)) {
        s.add(ev.threadId)
        getters.get(ev.queueId)!.push(ev.threadId)
      }
    }
  }

  const leftX = PAD_X + PILL_W / 2
  const pipeX = leftX + PILL_W / 2 + COL_GAP + PIPE_W / 2
  const rightX = pipeX + PIPE_W / 2 + COL_GAP + PILL_W / 2
  const contentW = Math.max(hostW, rightX + PILL_W / 2 + PAD_X)

  const pipes: Pipe[] = []
  const pills: ThreadPill[] = []
  let yCursor = PAD_Y + 28

  for (const q of queues) {
    const puts = putters.get(q.id) ?? []
    const gets = getters.get(q.id) ?? []
    const sortT = (ids: number[]) =>
      [...ids].sort((a, b) => {
        const na = flowThreadLabel(tr, a)
        const nb = flowThreadLabel(tr, b)
        return na.localeCompare(nb) || a - b
      })
    const putIds = sortT(puts)
    const getIds = sortT(gets)
    const ports = Math.max(1, putIds.length, getIds.length)
    const h = pipeHeight(putIds.length, getIds.length)
    const bandH = Math.max(h + 8, ports * PORT_GAP + 8)
    const cy = yCursor + bandH / 2

    const pipe: Pipe = {
      id: `q:${q.id}`,
      queueId: q.id,
      label: queueLabel(q),
      cap: q.cap ?? Math.max(1, q.peak),
      depth: q.samples.length ? q.samples[q.samples.length - 1]!.depth : 0,
      drops: q.drops,
      x: pipeX,
      y: cy,
      h,
      putPorts: Math.max(1, putIds.length),
      getPorts: Math.max(1, getIds.length),
    }
    pipes.push(pipe)

    putIds.forEach((tid, i) => {
      pills.push({
        id: pillKey(q.id, tid, 'put'),
        tid,
        label: flowThreadLabel(tr, tid),
        x: leftX,
        y: pillY(pipe, i, putIds.length),
        side: 'put',
        queueId: q.id,
        port: i,
      })
    })
    getIds.forEach((tid, i) => {
      pills.push({
        id: pillKey(q.id, tid, 'get'),
        tid,
        label: flowThreadLabel(tr, tid),
        x: rightX,
        y: pillY(pipe, i, getIds.length),
        side: 'get',
        queueId: q.id,
        port: i,
      })
    })

    yCursor += bandH + ROW_GAP
  }

  return {
    w: contentW,
    h: Math.max(160, yCursor + PAD_Y),
    pipes,
    pills,
    byPipe: new Map(pipes.map((p) => [p.queueId, p])),
    byPill: new Map(pills.map((p) => [p.id, p])),
  }
}

export function QueueGraph({
  tr,
  queues,
  eventCount,
}: {
  tr: Trace
  queues: QueueSeries[]
  eventCount: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const edgeStateRef = useRef(new Map<string, EdgeState>())
  const lastIndexRef = useRef(-1)
  const layoutRef = useRef<Layout | null>(null)
  const svgRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null)
  const layersRef = useRef<{
    labels: d3.Selection<SVGGElement, unknown, null, undefined>
    links: d3.Selection<SVGGElement, unknown, null, undefined>
    packets: d3.Selection<SVGGElement, unknown, null, undefined>
    pipes: d3.Selection<SVGGElement, unknown, null, undefined>
    pills: d3.Selection<SVGGElement, unknown, null, undefined>
  } | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const svg = d3.select(host).append('svg').attr('class', 'block w-full')
    const defs = svg.append('defs')

    // One marker; fill follows stroke via context-stroke. userSpaceOnUse keeps
    // size stable; path shortening ensures the tip meets the flange.
    const marker = defs
      .append('marker')
      .attr('id', 'qg-arrow')
      .attr('viewBox', `0 0 ${ARROW_LEN} ${ARROW_W}`)
      .attr('refX', ARROW_LEN)
      .attr('refY', ARROW_W / 2)
      .attr('markerWidth', ARROW_LEN)
      .attr('markerHeight', ARROW_W)
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('orient', 'auto')
    marker
      .append('path')
      .attr('d', `M0,0 L${ARROW_LEN},${ARROW_W / 2} L0,${ARROW_W} Z`)
      .attr('fill', 'context-stroke')

    defs
      .append('clipPath')
      .attr('id', CLIP_PILL)
      .append('rect')
      .attr('x', -PILL_W / 2 + 1)
      .attr('y', -PILL_H / 2 + 1)
      .attr('width', PILL_W - 2)
      .attr('height', PILL_H - 2)
      .attr('rx', 5)

    layersRef.current = {
      labels: svg.append('g'),
      links: svg.append('g'),
      packets: svg.append('g'),
      pipes: svg.append('g'),
      pills: svg.append('g'),
    }
    svgRef.current = svg
    const ro = new ResizeObserver(() => setLayoutTick((n) => n + 1))
    ro.observe(host)
    return () => {
      ro.disconnect()
      svg.remove()
      svgRef.current = null
      layersRef.current = null
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    const svg = svgRef.current
    const layers = layersRef.current
    if (!host || !svg || !layers) return

    if (queues.length === 0) {
      layers.pipes.selectAll('*').remove()
      layers.pills.selectAll('*').remove()
      layers.links.selectAll('*').remove()
      layers.labels.selectAll('*').remove()
      svg.attr('viewBox', '0 0 320 120').attr('height', 120)
      return
    }

    const layout = buildLayout(tr, queues, host.clientWidth || 320)
    layoutRef.current = layout
    svg.attr('viewBox', `0 0 ${layout.w} ${layout.h}`).attr('height', layout.h)

    layers.labels.selectAll('*').remove()
    const headers = [
      { x: PAD_X + PILL_W / 2, t: 'Put' },
      { x: layout.pipes[0]?.x ?? layout.w / 2, t: 'Queue' },
      { x: layout.w - PAD_X - PILL_W / 2, t: 'Get' },
    ]
    layers.labels
      .selectAll('text')
      .data(headers)
      .enter()
      .append('text')
      .attr('fill', 'rgba(148,163,184,0.7)')
      .attr('font-size', 9)
      .attr('font-weight', 600)
      .attr('letter-spacing', '0.08em')
      .attr('text-anchor', 'middle')
      .attr('y', 12)
      .attr('x', (d) => d.x)
      .text((d) => d.t.toUpperCase())

    const flow = queueFlowEvents(tr)
    const newest = flow.filter((ev) => ev.index > lastIndexRef.current)
    const firstPaint = lastIndexRef.current < 0
    if (newest.length) {
      lastIndexRef.current = flow[flow.length - 1]!.index
      const toAnim = newest.filter((ev) => ev.ok && ev.threadId != null).slice(-MAX_ANIM_PER_TICK)
      for (const ev of toAnim) firePacket(ev, layout, layers.packets, edgeStateRef.current)
    } else if (firstPaint) {
      lastIndexRef.current = flow.length ? flow[flow.length - 1]!.index : -1
      const recent = flow.filter((ev) => ev.ok && ev.threadId != null).slice(-10)
      const now = performance.now()
      for (const ev of recent) {
        edgeStateRef.current.set(
          flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }),
          {
            op: ev.op,
            untilHot: now + 350,
            untilWarm: now + WARM_MS,
            queueId: ev.queueId,
            threadId: ev.threadId!,
          },
        )
      }
    }

    paintFrame(layers, layout, edgeStateRef.current)

    const interval = window.setInterval(() => {
      if (layoutRef.current) paintFrame(layers, layoutRef.current, edgeStateRef.current)
    }, 180)
    return () => window.clearInterval(interval)
  }, [tr, queues, eventCount, layoutTick])

  return (
    <div
      ref={hostRef}
      className="overflow-x-auto overflow-y-hidden rounded border border-border/60 bg-slate-950/40"
      style={{ minHeight: 140 }}
    />
  )
}

function firePacket(
  ev: QueueFlowEvent,
  layout: Layout,
  packets: d3.Selection<SVGGElement, unknown, null, undefined>,
  edgeState: Map<string, EdgeState>,
) {
  if (ev.threadId == null) return
  const pipe = layout.byPipe.get(ev.queueId)
  const pill = layout.byPill.get(pillKey(ev.queueId, ev.threadId, sideForOp(ev.op)))
  if (!pipe || !pill) return

  const key = flowEdgeId({ threadId: ev.threadId, queueId: ev.queueId, op: ev.op })
  const now = performance.now()
  edgeState.set(key, {
    op: ev.op,
    untilHot: now + HOT_MS,
    untilWarm: now + WARM_MS,
    queueId: ev.queueId,
    threadId: ev.threadId,
  })

  const p = edgePath(pill, pipe, ev.op)
  const pkt = packets
    .append('circle')
    .attr('r', 3.2)
    .attr('fill', packetFill(ev.op))
    .attr('cx', p.sx)
    .attr('cy', p.sy)
  pkt
    .transition()
    .duration(480)
    .ease(d3.easeCubicOut)
    .attrTween('cx', () => (t) => {
      const u = 1 - t
      return String(u * u * p.sx + 2 * u * t * p.mx + t * t * p.ex)
    })
    .attrTween('cy', () => (t) => {
      const u = 1 - t
      return String(u * u * p.sy + 2 * u * t * p.my + t * t * p.ey)
    })
    .attr('opacity', 0.12)
    .remove()
}

function paintFrame(
  layers: {
    links: d3.Selection<SVGGElement, unknown, null, undefined>
    pipes: d3.Selection<SVGGElement, unknown, null, undefined>
    pills: d3.Selection<SVGGElement, unknown, null, undefined>
  },
  layout: Layout,
  edgeState: Map<string, EdgeState>,
) {
  const now = performance.now()
  const active: Array<{
    key: string
    pill: ThreadPill
    pipe: Pipe
    op: QueueFlowOp
    hot: boolean
  }> = []

  for (const [key, st] of edgeState) {
    if (now > st.untilWarm) {
      edgeState.delete(key)
      continue
    }
    const pipe = layout.byPipe.get(st.queueId)
    const pill = layout.byPill.get(pillKey(st.queueId, st.threadId, sideForOp(st.op)))
    if (!pipe || !pill) continue
    active.push({ key, pill, pipe, op: st.op, hot: now < st.untilHot })
  }

  const activePills = new Set(active.map((a) => a.pill.id))
  const structural: typeof active = []
  for (const pill of layout.pills) {
    const pipe = layout.byPipe.get(pill.queueId)
    if (!pipe) continue
    if (activePills.has(pill.id)) continue
    const op: QueueFlowOp = pill.side === 'put' ? 'put' : 'get'
    const key = flowEdgeId({ threadId: pill.tid, queueId: pill.queueId, op })
    structural.push({ key: `struct:${key}`, pill, pipe, op, hot: false })
  }

  const allLinks = [...structural, ...active]
  const link = layers.links
    .selectAll<SVGPathElement, (typeof allLinks)[0]>('path')
    .data(allLinks, (d) => d.key)
  link.exit().remove()
  link
    .enter()
    .append('path')
    .attr('fill', 'none')
    .attr('stroke-linecap', 'butt')
    .attr('stroke-linejoin', 'round')
    .merge(link)
    .attr('marker-end', (d) => (d.key.startsWith('struct:') ? null : 'url(#qg-arrow)'))
    .attr('stroke', (d) => strokeFor(d.op))
    .attr('stroke-width', (d) => (d.key.startsWith('struct:') ? 1 : d.hot ? 2.4 : 1.7))
    .attr('opacity', (d) => (d.key.startsWith('struct:') ? 0.18 : d.hot ? 0.95 : 0.45))
    .attr('d', (d) => edgePath(d.pill, d.pipe, d.op).d)

  const hotQueues = new Set(active.filter((a) => a.hot).map((a) => a.pipe.id))
  const pipeSel = layers.pipes.selectAll<SVGGElement, Pipe>('g.pipe').data(layout.pipes, (d) => d.id)
  pipeSel.exit().remove()
  const pipeEnter = pipeSel.enter().append('g').attr('class', 'pipe')
  const pipeMerged = pipeEnter.merge(pipeSel)
  pipeMerged.attr('transform', (d) => `translate(${d.x},${d.y})`)
  pipeMerged.each(function (d) {
    drawPipe(d3.select(this), d, hotQueues.has(d.id))
  })

  const hotPills = new Set(
    active.filter((a) => a.hot).map((a) => pillKey(a.pill.queueId, a.pill.tid, a.pill.side)),
  )
  const pillSel = layers.pills
    .selectAll<SVGGElement, ThreadPill>('g.pill')
    .data(layout.pills, (d) => d.id)
  pillSel.exit().remove()
  const pillEnter = pillSel.enter().append('g').attr('class', 'pill')
  pillEnter
    .append('rect')
    .attr('x', -PILL_W / 2)
    .attr('y', -PILL_H / 2)
    .attr('width', PILL_W)
    .attr('height', PILL_H)
    .attr('rx', 6)
  pillEnter
    .append('text')
    .attr('clip-path', `url(#${CLIP_PILL})`)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 10)
    .attr('font-weight', 500)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  const pillMerged = pillEnter.merge(pillSel)
  pillMerged.attr('transform', (d) => `translate(${d.x},${d.y})`)
  pillMerged.each(function (d) {
    const g = d3.select(this)
    const hot = hotPills.has(d.id)
    const put = d.side === 'put'
    g.select('rect')
      .attr(
        'fill',
        hot
          ? put
            ? 'rgba(96, 165, 250, 0.28)'
            : 'rgba(251, 191, 36, 0.28)'
          : put
            ? 'rgba(96, 165, 250, 0.1)'
            : 'rgba(251, 191, 36, 0.1)',
      )
      .attr('stroke', put ? '#60a5fa' : '#fbbf24')
      .attr('stroke-width', hot ? 1.8 : 1.2)
    const label = fitEllipsis(d.label, PILL_TEXT_MAX, GRAPH_FONT.pill)
    g.select('text').attr('fill', 'rgba(248,250,252,0.95)').text(label)
    g.attr('aria-label', d.label)
    g.selectAll('title').remove()
    g.append('title').text(d.label)
  })
}

/** Draw a horizontal pipe: flanges, barrel, bore, liquid fill, label. */
function drawPipe(g: d3.Selection<SVGGElement, unknown, null, undefined>, pipe: Pipe, hot: boolean): void {
  const x = -PIPE_W / 2
  const y = -pipe.h / 2
  const w = PIPE_W
  const h = pipe.h
  const rx = Math.min(10, h / 3)

  g.selectAll('*').remove()

  g.append('rect')
    .attr('x', x + 2)
    .attr('y', y + 3)
    .attr('width', w)
    .attr('height', h)
    .attr('rx', rx)
    .attr('fill', 'rgba(0,0,0,0.35)')

  g.append('rect')
    .attr('x', x)
    .attr('y', y)
    .attr('width', w)
    .attr('height', h)
    .attr('rx', rx)
    .attr('fill', hot ? '#455266' : '#3f4a5c')
    .attr('stroke', '#7c8aa0')
    .attr('stroke-width', hot ? 1.8 : 1.4)

  g.append('rect')
    .attr('x', x + FLANGE_W + 2)
    .attr('y', y + 3)
    .attr('width', w - FLANGE_W * 2 - 4)
    .attr('height', Math.max(4, h * 0.22))
    .attr('rx', 3)
    .attr('fill', 'rgba(226,232,240,0.14)')

  g.append('rect')
    .attr('x', x - 2)
    .attr('y', y - 4)
    .attr('width', FLANGE_W + 2)
    .attr('height', h + 8)
    .attr('rx', 3)
    .attr('fill', '#4b5568')
    .attr('stroke', '#94a3b8')
    .attr('stroke-width', 1.2)

  g.append('rect')
    .attr('x', x + w - FLANGE_W)
    .attr('y', y - 4)
    .attr('width', FLANGE_W + 2)
    .attr('height', h + 8)
    .attr('rx', 3)
    .attr('fill', '#4b5568')
    .attr('stroke', '#94a3b8')
    .attr('stroke-width', 1.2)

  const boreX = x + FLANGE_W + 1
  const boreY = y + BORE_INSET
  const boreW = w - FLANGE_W * 2 - 2
  const boreH = h - BORE_INSET * 2
  g.append('rect')
    .attr('x', boreX)
    .attr('y', boreY)
    .attr('width', boreW)
    .attr('height', boreH)
    .attr('rx', 4)
    .attr('fill', '#0f172a')
    .attr('stroke', '#1e293b')
    .attr('stroke-width', 1)

  const fillFrac = pipe.cap > 0 ? Math.min(1, pipe.depth / pipe.cap) : 0
  const fillW = Math.max(0, (boreW - 4) * fillFrac)
  if (fillW > 0) {
    g.append('rect')
      .attr('x', boreX + 2)
      .attr('y', boreY + 2)
      .attr('width', fillW)
      .attr('height', boreH - 4)
      .attr('rx', 3)
      .attr('fill', pipe.drops > 0 ? 'rgba(248,113,113,0.55)' : 'rgba(56,189,248,0.45)')
  }

  for (const ox of [x + FLANGE_W / 2, x + w - FLANGE_W / 2]) {
    g.append('ellipse')
      .attr('cx', ox)
      .attr('cy', 0)
      .attr('rx', 3.5)
      .attr('ry', Math.max(8, h / 2 - 4))
      .attr('fill', '#0b1220')
      .attr('stroke', '#64748b')
      .attr('stroke-width', 1)
  }

  const clipId = `qg-clip-pipe-${pipe.queueId}`
  g.append('clipPath')
    .attr('id', clipId)
    .append('rect')
    .attr('x', boreX + 4)
    .attr('y', boreY)
    .attr('width', boreW - 8)
    .attr('height', boreH)

  const name = fitEllipsis(pipe.label, PIPE_TEXT_MAX, GRAPH_FONT.tubeName)
  const meta = fitEllipsis(
    `${pipe.depth}/${pipe.cap} · ${pipe.drops} drop${pipe.drops === 1 ? '' : 's'}`,
    PIPE_TEXT_MAX,
    GRAPH_FONT.tubeMeta,
  )
  const labelG = g.append('g').attr('clip-path', `url(#${clipId})`)
  labelG
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('y', -5)
    .attr('fill', 'rgba(248,250,252,0.95)')
    .attr('font-size', 11)
    .attr('font-weight', 600)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .text(name)
  labelG
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('y', 9)
    .attr('fill', 'rgba(148,163,184,0.9)')
    .attr('font-size', 9)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .text(meta)

  g.append('title').text(`${pipe.label} — ${pipe.depth}/${pipe.cap}, ${pipe.drops} drops`)
}
