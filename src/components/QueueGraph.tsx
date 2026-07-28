/**
 * Per-queue pipe graph for the Trace Queues tab.
 *
 * Pipe orientation follows the Zephyr msgq ring-buffer contract:
 *   left  = end   — k_msgq_put writes here (write_ptr / back)
 *   right = front — k_msgq_get reads here; k_msgq_put_front inserts here
 *                   (read_ptr / head; delivered before older messages)
 *
 * @see https://docs.zephyrproject.org/latest/doxygen/html/group__msgq__apis.html
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

const PILL_W = 120
const PILL_H = 26
const PILL_PAD_X = 10
/** Barrel length between mouth centers. */
const PIPE_W = 200
/** Fixed cylinder height — ports attach near the bore centerline. */
const PIPE_H = 36
/** Horizontal radius of the mouth ellipses (perspective end-caps). */
const MOUTH_RX = 7
const MOUTH_RY = PIPE_H / 2 - 1
/** Vertical gap between thread pills on the same side. */
const PORT_GAP = 44
const ROW_GAP = 36
const COL_GAP = 56
const PAD_X = 16
const PAD_Y = 8
/** Extra top clearance for put_front arcs over the barrel. */
const ARC_CLEAR = 22
const ARROW_LEN = 8
const ARROW_W = 6

const PILL_TEXT_MAX = PILL_W - PILL_PAD_X * 2
const PIPE_TEXT_MAX = PIPE_W - MOUTH_RX * 4 - 12

const CLIP_PILL = 'qg-clip-pill'

type ThreadPill = {
  id: string
  tid: number
  label: string
  x: number
  y: number
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

type Layers = {
  labels: d3.Selection<SVGGElement, unknown, null, undefined>
  links: d3.Selection<SVGGElement, unknown, null, undefined>
  packets: d3.Selection<SVGGElement, unknown, null, undefined>
  pipes: d3.Selection<SVGGElement, unknown, null, undefined>
  pills: d3.Selection<SVGGElement, unknown, null, undefined>
}

function pillKey(queueId: number, tid: number, side: 'put' | 'get') {
  return `p:${queueId}:${tid}:${side}`
}

function sideForOp(op: QueueFlowOp): 'put' | 'get' {
  return isPutOp(op) ? 'put' : 'get'
}

function pipeEndX(pipe: Pipe): number {
  return pipe.x - PIPE_W / 2
}

function pipeFrontX(pipe: Pipe): number {
  return pipe.x + PIPE_W / 2
}

/**
 * Mouth attachment Y. Single port → bore centerline; multiple ports fan
 * slightly inside the mouth ellipse so arrows stay parallel.
 */
function mouthY(pipe: Pipe, mouth: 'end' | 'front', port: number): number {
  const n = mouth === 'end' ? pipe.putPorts : pipe.getPorts
  if (n <= 1) return pipe.y
  const inner = Math.min(10, (MOUTH_RY * 1.4) / Math.max(1, n - 1))
  const span = (n - 1) * inner
  return pipe.y - span / 2 + port * inner
}

function pillY(pipe: Pipe, port: number, count: number): number {
  const span = Math.max(0, (count - 1) * PORT_GAP)
  return pipe.y - span / 2 + port * PORT_GAP
}

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

  if (op === 'put_front') {
    // Insert at front/head — arc *above* the barrel, land on front mouth.
    const ey = mouthY(pipe, 'front', Math.min(pill.port, Math.max(0, pipe.getPorts - 1)))
    const tipX = pipeFrontX(pipe)
    const raw = edgeEndpoints(pill.x + PILL_W / 2, sy, tipX, ey, ARROW_LEN)
    const over = pipe.y - PIPE_H / 2 - ARC_CLEAR
    const c1x = raw.x1 + (pipeEndX(pipe) - raw.x1) * 0.55
    const c2x = tipX - COL_GAP * 0.35
    return {
      sx: raw.x1,
      sy: raw.y1,
      ex: raw.x2,
      ey: raw.y2,
      mx: (raw.x1 + raw.x2) / 2,
      my: over,
      d: `M${raw.x1},${raw.y1} C${c1x},${over} ${c2x},${over} ${raw.x2},${raw.y2}`,
    }
  }

  if (op === 'put') {
    const ey = mouthY(pipe, 'end', pill.port)
    const raw = edgeEndpoints(pill.x + PILL_W / 2, sy, pipeEndX(pipe), ey, ARROW_LEN)
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

  const ey = mouthY(pipe, 'front', pill.port)
  const raw = edgeEndpoints(pipeFrontX(pipe), ey, pill.x - PILL_W / 2, sy, ARROW_LEN)
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
  // Room for column headers + put_front arc above the first pipe.
  let yCursor = PAD_Y + 18 + ARC_CLEAR

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
    const bandH = Math.max(PIPE_H + 8, ports * PORT_GAP)
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
    h: Math.max(120, yCursor + PAD_Y),
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
  const layersRef = useRef<Layers | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const svg = d3.select(host).append('svg').attr('class', 'block w-full')
    const defs = svg.append('defs')

    // Soft metal gradient for the barrel.
    const grad = defs
      .append('linearGradient')
      .attr('id', 'qg-pipe-metal')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%')
    grad.append('stop').attr('offset', '0%').attr('stop-color', '#6b7280')
    grad.append('stop').attr('offset', '35%').attr('stop-color', '#4b5563')
    grad.append('stop').attr('offset', '70%').attr('stop-color', '#374151')
    grad.append('stop').attr('offset', '100%').attr('stop-color', '#1f2937')

    const fillGrad = defs
      .append('linearGradient')
      .attr('id', 'qg-pipe-liquid')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%')
    fillGrad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(125,211,252,0.75)')
    fillGrad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(14,165,233,0.55)')

    const fillHot = defs
      .append('linearGradient')
      .attr('id', 'qg-pipe-liquid-drop')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%')
    fillHot.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(252,165,165,0.75)')
    fillHot.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(239,68,68,0.5)')

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
      .attr('d', `M0,0.5 L${ARROW_LEN},${ARROW_W / 2} L0,${ARROW_W - 0.5} Z`)
      .attr('fill', 'context-stroke')

    defs
      .append('clipPath')
      .attr('id', CLIP_PILL)
      .append('rect')
      .attr('x', -PILL_W / 2 + 1)
      .attr('y', -PILL_H / 2 + 1)
      .attr('width', PILL_W - 2)
      .attr('height', PILL_H - 2)
      .attr('rx', 6)

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
      svg.attr('viewBox', '0 0 320 100').attr('height', 100)
      return
    }

    const layout = buildLayout(tr, queues, host.clientWidth || 320)
    layoutRef.current = layout
    svg.attr('viewBox', `0 0 ${layout.w} ${layout.h}`).attr('height', layout.h)

    layers.labels.selectAll('*').remove()
    const headers = [
      { x: PAD_X + PILL_W / 2, t: 'put · end' },
      { x: layout.pipes[0]?.x ?? layout.w / 2, t: 'msgq' },
      { x: layout.w - PAD_X - PILL_W / 2, t: 'front · get' },
    ]
    layers.labels
      .selectAll('text')
      .data(headers)
      .enter()
      .append('text')
      .attr('fill', 'rgba(148,163,184,0.65)')
      .attr('font-size', 9)
      .attr('font-weight', 600)
      .attr('letter-spacing', '0.06em')
      .attr('text-anchor', 'middle')
      .attr('y', 14)
      .attr('x', (d) => d.x)
      .text((d) => d.t.toUpperCase())

    // Rebuild pipe shells once per layout (not every animation tick).
    const pipeSel = layers.pipes.selectAll<SVGGElement, Pipe>('g.pipe').data(layout.pipes, (d) => d.id)
    pipeSel.exit().remove()
    const pipeEnter = pipeSel.enter().append('g').attr('class', 'pipe')
    pipeEnter.each(function (d) {
      buildPipeShell(d3.select(this), d)
    })
    pipeEnter
      .merge(pipeSel)
      .attr('transform', (d) => `translate(${d.x},${d.y})`)
      .each(function (d) {
        updatePipeFill(d3.select(this), d, false)
      })

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
      style={{ minHeight: 120 }}
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
    .attr('r', 3)
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

function paintFrame(layers: Layers, layout: Layout, edgeState: Map<string, EdgeState>) {
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

  const activeByPillOp = new Set(active.map((a) => `${a.pill.id}|${a.op}`))
  const structural: typeof active = []
  for (const pill of layout.pills) {
    const pipe = layout.byPipe.get(pill.queueId)
    if (!pipe) continue
    const op: QueueFlowOp = pill.side === 'put' ? 'put' : 'get'
    if (activeByPillOp.has(`${pill.id}|${op}`)) continue
    // Keep a faint structural put even when put_front is glowing.
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
    .attr('stroke-width', (d) => (d.key.startsWith('struct:') ? 1.1 : d.hot ? 2.2 : 1.6))
    .attr('opacity', (d) => (d.key.startsWith('struct:') ? 0.2 : d.hot ? 0.95 : 0.5))
    .attr('d', (d) => edgePath(d.pill, d.pipe, d.op).d)

  const hotQueues = new Set(active.filter((a) => a.hot).map((a) => a.pipe.id))
  layers.pipes.selectAll<SVGGElement, Pipe>('g.pipe').each(function (d) {
    updatePipeFill(d3.select(this), d, hotQueues.has(d.id))
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
    .attr('rx', 7)
  pillEnter
    .append('text')
    .attr('clip-path', `url(#${CLIP_PILL})`)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 11)
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
            ? 'rgba(96, 165, 250, 0.22)'
            : 'rgba(251, 191, 36, 0.22)'
          : put
            ? 'rgba(96, 165, 250, 0.08)'
            : 'rgba(251, 191, 36, 0.08)',
      )
      .attr('stroke', put ? '#60a5fa' : '#fbbf24')
      .attr('stroke-width', hot ? 1.6 : 1.1)
    g.select('text')
      .attr('fill', 'rgba(248,250,252,0.95)')
      .text(fitEllipsis(d.label, PILL_TEXT_MAX, GRAPH_FONT.pill))
    g.attr('aria-label', d.label)
    g.selectAll('title').remove()
    g.append('title').text(d.label)
  })
}

/**
 * Build a clean horizontal cylinder once: end-cap ellipses + barrel + bore.
 * Live depth updates go through updatePipeFill so we don't rebuild every tick.
 */
function buildPipeShell(g: d3.Selection<SVGGElement, unknown, null, undefined>, pipe: Pipe): void {
  g.selectAll('*').remove()

  const x0 = -PIPE_W / 2
  const x1 = PIPE_W / 2
  const y0 = -PIPE_H / 2
  const y1 = PIPE_H / 2

  // Drop shadow
  g.append('ellipse')
    .attr('cx', 0)
    .attr('cy', y1 + 4)
    .attr('rx', PIPE_W / 2 - 4)
    .attr('ry', 5)
    .attr('fill', 'rgba(0,0,0,0.35)')

  // Barrel body (between mouth centers), clipped by nothing — mouths drawn on top.
  g.append('rect')
    .attr('class', 'barrel')
    .attr('x', x0)
    .attr('y', y0)
    .attr('width', PIPE_W)
    .attr('height', PIPE_H)
    .attr('rx', MOUTH_RY)
    .attr('fill', 'url(#qg-pipe-metal)')
    .attr('stroke', '#9ca3af')
    .attr('stroke-width', 1.1)

  // Top specular stripe
  g.append('rect')
    .attr('x', x0 + MOUTH_RX + 4)
    .attr('y', y0 + 3)
    .attr('width', PIPE_W - MOUTH_RX * 2 - 8)
    .attr('height', 5)
    .attr('rx', 2.5)
    .attr('fill', 'rgba(255,255,255,0.14)')

  // Bore (inner dark channel)
  const boreX = x0 + MOUTH_RX + 2
  const boreY = y0 + 8
  const boreW = PIPE_W - MOUTH_RX * 2 - 4
  const boreH = PIPE_H - 16
  g.append('rect')
    .attr('class', 'bore')
    .attr('x', boreX)
    .attr('y', boreY)
    .attr('width', boreW)
    .attr('height', boreH)
    .attr('rx', boreH / 2)
    .attr('fill', '#0b1220')

  // Liquid occupancy — width updated live.
  g.append('rect')
    .attr('class', 'fill')
    .attr('x', boreX + 2)
    .attr('y', boreY + 2)
    .attr('height', boreH - 4)
    .attr('rx', (boreH - 4) / 2)
    .attr('width', 0)
    .attr('fill', 'url(#qg-pipe-liquid)')

  // Left mouth (end) — outer ring + dark aperture
  g.append('ellipse')
    .attr('cx', x0)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX)
    .attr('ry', MOUTH_RY)
    .attr('fill', '#4b5563')
    .attr('stroke', '#d1d5db')
    .attr('stroke-width', 1.2)
  g.append('ellipse')
    .attr('class', 'mouth-end')
    .attr('cx', x0)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX - 2.5)
    .attr('ry', MOUTH_RY - 4)
    .attr('fill', '#020617')
    .attr('stroke', '#64748b')
    .attr('stroke-width', 0.8)

  // Right mouth (front)
  g.append('ellipse')
    .attr('cx', x1)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX)
    .attr('ry', MOUTH_RY)
    .attr('fill', '#4b5563')
    .attr('stroke', '#d1d5db')
    .attr('stroke-width', 1.2)
  g.append('ellipse')
    .attr('class', 'mouth-front')
    .attr('cx', x1)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX - 2.5)
    .attr('ry', MOUTH_RY - 4)
    .attr('fill', '#020617')
    .attr('stroke', '#64748b')
    .attr('stroke-width', 0.8)

  // Tiny end / front captions under mouths
  g.append('text')
    .attr('x', x0)
    .attr('y', y1 + 11)
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(148,163,184,0.7)')
    .attr('font-size', 8)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .text('end')
  g.append('text')
    .attr('x', x1)
    .attr('y', y1 + 11)
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(148,163,184,0.7)')
    .attr('font-size', 8)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .text('front')

  const clipId = `qg-clip-pipe-${pipe.queueId}`
  g.append('clipPath')
    .attr('id', clipId)
    .append('rect')
    .attr('x', boreX + 4)
    .attr('y', boreY)
    .attr('width', boreW - 8)
    .attr('height', boreH)

  const labelG = g.append('g').attr('class', 'labels').attr('clip-path', `url(#${clipId})`)
  labelG
    .append('text')
    .attr('class', 'name')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('y', -4)
    .attr('fill', 'rgba(248,250,252,0.95)')
    .attr('font-size', 11)
    .attr('font-weight', 600)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
  labelG
    .append('text')
    .attr('class', 'meta')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .attr('y', 9)
    .attr('fill', 'rgba(148,163,184,0.9)')
    .attr('font-size', 9)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  g.append('title')
}

function updatePipeFill(
  g: d3.Selection<SVGGElement, unknown, null, undefined>,
  pipe: Pipe,
  hot: boolean,
): void {
  const boreW = PIPE_W - MOUTH_RX * 2 - 4
  const fillFrac = pipe.cap > 0 ? Math.min(1, pipe.depth / pipe.cap) : 0
  const fillW = Math.max(0, (boreW - 4) * fillFrac)

  g.select('rect.barrel').attr('stroke', hot ? '#e2e8f0' : '#9ca3af').attr('stroke-width', hot ? 1.5 : 1.1)
  g.select('rect.fill')
    .attr('width', fillW)
    .attr('fill', pipe.drops > 0 ? 'url(#qg-pipe-liquid-drop)' : 'url(#qg-pipe-liquid)')

  const name = fitEllipsis(pipe.label, PIPE_TEXT_MAX, GRAPH_FONT.tubeName)
  const meta = fitEllipsis(
    `${pipe.depth}/${pipe.cap}${pipe.drops ? ` · ${pipe.drops} drop${pipe.drops === 1 ? '' : 's'}` : ''}`,
    PIPE_TEXT_MAX,
    GRAPH_FONT.tubeMeta,
  )
  g.select('text.name').text(name)
  g.select('text.meta').text(meta)
  g.select('title').text(`${pipe.label} — ${pipe.depth}/${pipe.cap}, ${pipe.drops} drops`)
}
