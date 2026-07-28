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
/** Representative moving dots per route; the burst badge accounts for the rest. */
const MAX_PACKETS_PER_BURST = 3

const PILL_W = 120
const PILL_H = 26
const PILL_PAD_X = 10
/** Barrel length between mouth centers. */
const PIPE_W = 224
/** Fixed cylinder height — ports attach near the bore centerline. */
const PIPE_H = 44
/** Horizontal radius of the mouth ellipses (perspective end-caps). */
const MOUTH_RX = 10
const MOUTH_RY = PIPE_H / 2 - 1
const ROW_GAP = 36
const COL_GAP = 56
const PAD_X = 16
const PAD_Y = 8
/** Extra top clearance for put_front arcs over the barrel. */
const ARC_CLEAR = 28
/** Keeps the highest detour clear of the column labels. */
const DETOUR_HEADROOM = 76
const ARROW_LEN = 11
const ARROW_W = 10

const PILL_TEXT_MAX = PILL_W - PILL_PAD_X * 2
const PIPE_TEXT_MAX = PIPE_W - MOUTH_RX * 4 - 12

const CLIP_PILL = 'qg-clip-pill'

type ThreadNode = {
  id: string
  tid: number
  label: string
  x: number
  y: number
}

type FlowLink = {
  id: string
  threadId: number
  queueId: number
  op: QueueFlowOp
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
  /** Successful operations represented by this UI update. */
  count: number
  untilHot: number
  untilWarm: number
  queueId: number
  threadId: number
}

type Layout = {
  w: number
  h: number
  pipes: Pipe[]
  threads: ThreadNode[]
  links: FlowLink[]
  byPipe: Map<number, Pipe>
  byThread: Map<number, ThreadNode>
}

type Layers = {
  labels: d3.Selection<SVGGElement, unknown, null, undefined>
  links: d3.Selection<SVGGElement, unknown, null, undefined>
  packets: d3.Selection<SVGGElement, unknown, null, undefined>
  pipes: d3.Selection<SVGGElement, unknown, null, undefined>
  pills: d3.Selection<SVGGElement, unknown, null, undefined>
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

/**
 * put_front shares the physical front mouth with get. Give inserts their own
 * entry lanes so their arrows do not sit directly on top of outgoing gets.
 */
function frontInsertY(pipe: Pipe, port: number): number {
  const count = pipe.putPorts
  if (count <= 1) return pipe.y - Math.min(8, MOUTH_RY * 0.45)
  const usable = Math.min(10, MOUTH_RY - 5)
  return pipe.y + ((port + 0.5) / count - 0.5) * usable * 2
}

/**
 * Outside edge of a pipe mouth at a given attachment height. Links live below
 * the pipe layer, so ending here lets the arrow meet the aperture cleanly
 * without drawing through the tube shell.
 */
function mouthLipX(pipe: Pipe, mouth: 'end' | 'front', y: number): number {
  const dx = MOUTH_RX * Math.sqrt(Math.max(0, 1 - ((y - pipe.y) / MOUTH_RY) ** 2))
  return (mouth === 'end' ? pipeEndX(pipe) - dx : pipeFrontX(pipe) + dx)
}

type EdgePath = {
  sx: number
  sy: number
  ex: number
  ey: number
  d: string
}

type RoutePoint = { x: number; y: number }

/**
 * D3 owns the curve geometry. We provide semantic waypoints only; the
 * basis spline rounds the supplied routing rail without the large overshoot
 * Catmull–Rom produces when a source is far from the pipe.
 */
function smoothRoute(points: RoutePoint[]): EdgePath {
  const d = d3
    .line<RoutePoint>()
    .x((point) => point.x)
    .y((point) => point.y)
    .curve(d3.curveBasis)(points)
  return {
    sx: points[0]!.x,
    sy: points[0]!.y,
    ex: points.at(-1)!.x,
    ey: points.at(-1)!.y,
    d: d ?? '',
  }
}

function edgePath(
  thread: ThreadNode,
  pipe: Pipe,
  link: FlowLink,
): EdgePath {
  const { op } = link
  const threadEdge = (towardX: number) => ({
    x: thread.x + (towardX >= thread.x ? PILL_W / 2 : -PILL_W / 2),
    y: thread.y,
  })

  if (op === 'put_front') {
    // Insert at front/head: go over the barrel, past its east end, then make a
    // deliberate U-turn so the arrow enters the front port from the east.
    const ey = frontInsertY(pipe, link.port)
    const start = threadEdge(pipeFrontX(pipe))
    const end = { x: mouthLipX(pipe, 'front', ey), y: ey }
    const rise = ARC_CLEAR + 12 + Math.max(0, pipe.putPorts - link.port - 1) * 10
    const railY = pipe.y - PIPE_H / 2 - rise
    const eastTurnX = pipeFrontX(pipe) + 30
    // A compact raised rail plus a small east-side turn: the route visibly
    // detours, but never dominates the whole graph.
    return smoothRoute([
      start,
      { x: pipeEndX(pipe) - 12, y: railY },
      { x: eastTurnX, y: railY },
      { x: eastTurnX + 12, y: ey },
      { x: end.x + 34, y: ey },
      end,
    ])
  }

  if (op === 'put') {
    const ey = mouthY(pipe, 'end', link.port)
    const start = threadEdge(pipeEndX(pipe))
    const end = { x: mouthLipX(pipe, 'end', ey), y: ey }
    if (start.x > end.x) {
      const railY = pipe.y - PIPE_H / 2 - ARC_CLEAR
      return smoothRoute([start, { x: pipeFrontX(pipe) + 24, y: railY }, { x: end.x - 24, y: railY }, end])
    }
    return smoothRoute([
      start,
      { x: (start.x + end.x) / 2, y: start.y },
      end,
    ])
  }

  const ey = mouthY(pipe, 'front', link.port)
  const start = { x: mouthLipX(pipe, 'front', ey), y: ey }
  const end = threadEdge(pipeFrontX(pipe))
  if (end.x < start.x) {
    const railY = pipe.y - PIPE_H / 2 - ARC_CLEAR
    return smoothRoute([start, { x: start.x + 24, y: railY }, { x: end.x - 24, y: railY }, end])
  }
  return smoothRoute([
    start,
    { x: (start.x + end.x) / 2, y: start.y },
    end,
  ])
}

function burstBadgePosition(thread: ThreadNode, pipe: Pipe, link: FlowLink) {
  const { op } = link
  if (op === 'put_front') {
    return { x: pipe.x, y: pipe.y - PIPE_H / 2 - ARC_CLEAR - 12 }
  }
  const from = op === 'get' ? pipeFrontX(pipe) : thread.x
  const to = op === 'get' ? thread.x : pipeEndX(pipe)
  return { x: (from + to) / 2, y: (thread.y + mouthY(pipe, op === 'get' ? 'front' : 'end', link.port)) / 2 - 9 }
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

function markerFor(op: QueueFlowOp): string {
  return `url(#qg-arrow-${op})`
}

function buildLayout(tr: Trace, queues: QueueSeries[], hostW: number): Layout {
  const flow = queueFlowEvents(tr)
  const valid = flow.filter((ev) => ev.ok && ev.threadId != null && queues.some((q) => q.id === ev.queueId))
  const threadIds = [...new Set(valid.map((ev) => ev.threadId!))].sort((a, b) =>
    flowThreadLabel(tr, a).localeCompare(flowThreadLabel(tr, b)) || a - b,
  )
  const puts = new Map<number, number[]>()
  const gets = new Map<number, number[]>()
  for (const q of queues) {
    puts.set(q.id, [])
    gets.set(q.id, [])
  }
  for (const ev of valid) {
    const bucket = isPutOp(ev.op) ? puts.get(ev.queueId)! : gets.get(ev.queueId)!
    if (!bucket.includes(ev.threadId!)) bucket.push(ev.threadId!)
  }

  const links: FlowLink[] = []
  const seen = new Set<string>()
  for (const ev of valid) {
    const id = flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op })
    if (seen.has(id)) continue
    seen.add(id)
    const portIds = isPutOp(ev.op) ? puts.get(ev.queueId)! : gets.get(ev.queueId)!
    links.push({ id, threadId: ev.threadId!, queueId: ev.queueId, op: ev.op, port: Math.max(0, portIds.indexOf(ev.threadId!)) })
  }

  // Longest-path ranks make the common producer → queue → consumer pipeline
  // read left-to-right. Cycles fall back to a shared column instead of cloning
  // a thread node merely to satisfy both of its ports.
  const nodeIds = [...threadIds.map((tid) => `t:${tid}`), ...queues.map((q) => `q:${q.id}`)]
  const outgoing = new Map(nodeIds.map((id) => [id, new Set<string>()]))
  const indegree = new Map(nodeIds.map((id) => [id, 0]))
  for (const link of links) {
    const from = link.op === 'get' ? `q:${link.queueId}` : `t:${link.threadId}`
    const to = link.op === 'get' ? `t:${link.threadId}` : `q:${link.queueId}`
    if (!outgoing.get(from)!.has(to)) {
      outgoing.get(from)!.add(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }
  const rank = new Map(nodeIds.map((id) => [id, 0]))
  const ready = nodeIds.filter((id) => indegree.get(id) === 0)
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!
    for (const next of outgoing.get(id)!) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1))
      indegree.set(next, indegree.get(next)! - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }

  const byRank = d3.group(nodeIds, (id) => rank.get(id) ?? 0)
  const columnGap = PIPE_W + COL_GAP * 2
  const laneGap = Math.max(PILL_H, PIPE_H) + ROW_GAP
  const positions = new Map<string, { x: number; y: number }>()
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  let maxLanes = 1
  for (const value of byRank.values()) maxLanes = Math.max(maxLanes, value.length)
  for (const r of ranks) {
    const ids = byRank.get(r)!.sort((a, b) => a.localeCompare(b))
    ids.forEach((id, lane) => positions.set(id, { x: PAD_X + Math.max(PIPE_W, PILL_W) / 2 + r * columnGap, y: PAD_Y + 34 + DETOUR_HEADROOM + lane * laneGap }))
  }
  const pipes = queues.map((q) => {
    const pos = positions.get(`q:${q.id}`)!
    return { id: `q:${q.id}`, queueId: q.id, label: queueLabel(q), cap: q.cap ?? Math.max(1, q.peak), depth: q.samples.length ? q.samples[q.samples.length - 1]!.depth : 0, drops: q.drops, x: pos.x, y: pos.y, putPorts: Math.max(1, puts.get(q.id)!.length), getPorts: Math.max(1, gets.get(q.id)!.length) }
  })
  const threads = threadIds.map((tid) => {
    const pos = positions.get(`t:${tid}`)!
    return { id: `t:${tid}`, tid, label: flowThreadLabel(tr, tid), x: pos.x, y: pos.y }
  })
  const contentW = Math.max(hostW, PAD_X * 2 + Math.max(PIPE_W, PILL_W) + Math.max(0, ranks.length - 1) * columnGap)
  const contentH = Math.max(120, PAD_Y * 2 + 34 + DETOUR_HEADROOM + maxLanes * laneGap)
  return { w: contentW, h: contentH, pipes, threads, links, byPipe: new Map(pipes.map((p) => [p.queueId, p])), byThread: new Map(threads.map((t) => [t.tid, t])) }
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

    for (const op of ['put', 'put_front', 'get'] as const) {
      defs
        .append('marker')
        .attr('id', `qg-arrow-${op}`)
        .attr('viewBox', `0 0 ${ARROW_LEN} ${ARROW_W}`)
        .attr('refX', ARROW_LEN)
        .attr('refY', ARROW_W / 2)
        .attr('markerWidth', ARROW_LEN)
        .attr('markerHeight', ARROW_W)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path')
        .attr('d', `M0,0 L${ARROW_LEN},${ARROW_W / 2} L0,${ARROW_W} Z`)
        .attr('fill', strokeFor(op))
    }

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
    const headers = [{ x: layout.w / 2, t: 'message flow · put → end · front → get' }]
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
      const bursts = d3.group(
        newest.filter((ev) => ev.ok && ev.threadId != null),
        (ev) => flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }),
      )
      for (const events of bursts.values()) {
        fireBurst(events, layout, layers.packets, edgeStateRef.current)
      }
    } else if (firstPaint) {
      lastIndexRef.current = flow.length ? flow[flow.length - 1]!.index : -1
      const recent = flow.filter((ev) => ev.ok && ev.threadId != null).slice(-10)
      const now = performance.now()
      for (const ev of recent) {
        edgeStateRef.current.set(
          flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }),
          {
            op: ev.op,
            count: 1,
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

function fireBurst(
  events: QueueFlowEvent[],
  layout: Layout,
  packets: d3.Selection<SVGGElement, unknown, null, undefined>,
  edgeState: Map<string, EdgeState>,
) {
  const ev = events.at(-1)
  if (!ev) return
  if (ev.threadId == null) return
  const pipe = layout.byPipe.get(ev.queueId)
  const thread = layout.byThread.get(ev.threadId)
  const link = layout.links.find((candidate) => candidate.id === flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }))
  if (!pipe || !thread || !link) return

  const key = flowEdgeId({ threadId: ev.threadId, queueId: ev.queueId, op: ev.op })
  const now = performance.now()
  edgeState.set(key, {
    op: ev.op,
    count: events.length,
    untilHot: now + HOT_MS,
    untilWarm: now + WARM_MS,
    queueId: ev.queueId,
    threadId: ev.threadId,
  })

  const p = edgePath(thread, pipe, link)
  // The badge below represents every event. Limit moving dots only so a busy
  // slice remains readable rather than becoming a solid line.
  for (let index = 0; index < Math.min(events.length, MAX_PACKETS_PER_BURST); index++) {
    firePacket(p, ev.op, packets, index / Math.min(events.length, MAX_PACKETS_PER_BURST))
  }
}

function firePacket(
  p: EdgePath,
  op: QueueFlowOp,
  packets: d3.Selection<SVGGElement, unknown, null, undefined>,
  delay: number,
) {
  // Use the browser's path metrics so the packet travels on the same D3 spline
  // that is drawn, including the front-insert turn.
  const travelPath = packets.append('path').attr('d', p.d).attr('fill', 'none').attr('stroke', 'none')
  const pathNode = travelPath.node()
  const pathLength = pathNode?.getTotalLength() ?? 0
  const pkt = packets
    .append('circle')
    .attr('r', 4)
    .attr('fill', packetFill(op))
    .attr('stroke', 'rgba(248,250,252,0.8)')
    .attr('stroke-width', 0.75)
    .attr('cx', p.sx)
    .attr('cy', p.sy)
  pkt
    .transition()
    .delay(delay * 90)
    .duration(820)
    .ease(d3.easeCubicInOut)
    .attrTween('cx', () => (t) => String(pathNode?.getPointAtLength(pathLength * t).x ?? p.ex))
    .attrTween('cy', () => (t) => String(pathNode?.getPointAtLength(pathLength * t).y ?? p.ey))
    .attr('r', 2.5)
    .attr('opacity', 0.2)
    .on('end', () => travelPath.remove())
    .remove()
}

function paintFrame(layers: Layers, layout: Layout, edgeState: Map<string, EdgeState>) {
  const now = performance.now()
  const active: Array<{
    key: string
    thread: ThreadNode
    pipe: Pipe
    link: FlowLink
    count: number
    hot: boolean
  }> = []

  for (const [key, st] of edgeState) {
    if (now > st.untilWarm) {
      edgeState.delete(key)
      continue
    }
    const pipe = layout.byPipe.get(st.queueId)
    const thread = layout.byThread.get(st.threadId)
    const link = layout.links.find((candidate) => candidate.id === key)
    if (!pipe || !thread || !link) continue
    active.push({ key, thread, pipe, link, count: st.count, hot: now < st.untilHot })
  }

  const activeLinks = new Set(active.map((a) => a.key))
  const structural: typeof active = []
  for (const link of layout.links) {
    const pipe = layout.byPipe.get(link.queueId)
    const thread = layout.byThread.get(link.threadId)
    if (!pipe || !thread) continue
    // An active operation owns its lane; do not leave a second, structural
    // arrow underneath it just because that thread also uses normal put.
    if (activeLinks.has(link.id)) continue
    structural.push({ key: `struct:${link.id}`, thread, pipe, link, count: 0, hot: false })
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
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .merge(link)
    // Direction must remain legible even between the short-lived event pulses.
    .attr('marker-end', (d) => markerFor(d.link.op))
    .attr('stroke', (d) => strokeFor(d.link.op))
    .attr('stroke-width', (d) => (d.key.startsWith('struct:') ? 1.35 : d.hot ? 2.3 : 1.7))
    .attr('opacity', (d) => (d.key.startsWith('struct:') ? 0.52 : d.hot ? 0.96 : 0.68))
    .attr('d', (d) => edgePath(d.thread, d.pipe, d.link).d)

  const burstBadge = layers.packets
    .selectAll<SVGTextElement, (typeof active)[0]>('text.burst-count')
    .data(active.filter((entry) => entry.count > 1), (entry) => entry.key)
  burstBadge.exit().remove()
  burstBadge
    .enter()
    .append('text')
    .attr('class', 'burst-count')
    .attr('text-anchor', 'middle')
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .attr('font-size', 9)
    .attr('font-weight', 700)
    .attr('paint-order', 'stroke')
    .attr('stroke', '#020617')
    .attr('stroke-width', 3)
    .merge(burstBadge)
    .attr('x', (entry) => burstBadgePosition(entry.thread, entry.pipe, entry.link).x)
    .attr('y', (entry) => burstBadgePosition(entry.thread, entry.pipe, entry.link).y)
    .attr('fill', (entry) => packetFill(entry.link.op))
    .text((entry) => `×${entry.count}`)

  const hotQueues = new Set(active.filter((a) => a.hot).map((a) => a.pipe.id))
  layers.pipes.selectAll<SVGGElement, Pipe>('g.pipe').each(function (d) {
    updatePipeFill(d3.select(this), d, hotQueues.has(d.id))
  })

  const hotThreads = new Set(active.filter((a) => a.hot).map((a) => a.thread.id))
  const pillSel = layers.pills
    .selectAll<SVGGElement, ThreadNode>('g.pill')
    .data(layout.threads, (d) => d.id)
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
    const hot = hotThreads.has(d.id)
    g.select('rect')
      .attr(
        'fill',
        hot ? 'rgba(96, 165, 250, 0.22)' : 'rgba(96, 165, 250, 0.08)',
      )
      .attr('stroke', '#60a5fa')
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

  // A constant-height barrel keeps its top and bottom edges genuinely parallel.
  // Perspective comes only from the end caps, not from a tapered silhouette.
  g.append('path')
    .attr('class', 'barrel')
    .attr('d', `M${x0},${y0} H${x1} V${y1} H${x0} Z`)
    .attr('fill', '#151f30')
    .attr('stroke', 'rgba(203,213,225,0.72)')
    .attr('stroke-width', 0.85)

  // Flat inner channel; it carries queue occupancy without adding another rim.
  const boreX = x0 + MOUTH_RX + 3
  const boreY = y0 + 10
  const boreW = PIPE_W - MOUTH_RX * 2 - 6
  const boreH = PIPE_H - 20
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
    .attr('fill', '#38bdf8')
    .attr('fill-opacity', 0.56)

  // Left mouth (end) — outer ring + dark aperture
  g.append('ellipse')
    .attr('cx', x0)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX)
    .attr('ry', MOUTH_RY)
    .attr('fill', '#151f30')
    .attr('stroke', 'rgba(203,213,225,0.72)')
    .attr('stroke-width', 0.85)
  g.append('ellipse')
    .attr('class', 'mouth-end')
    .attr('cx', x0)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX - 2.5)
    .attr('ry', MOUTH_RY - 4)
    .attr('fill', '#0b1220')
    .attr('stroke', 'rgba(148,163,184,0.45)')
    .attr('stroke-width', 0.55)

  // Right mouth (front)
  g.append('ellipse')
    .attr('cx', x1)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX)
    .attr('ry', MOUTH_RY)
    .attr('fill', '#151f30')
    .attr('stroke', 'rgba(203,213,225,0.72)')
    .attr('stroke-width', 0.85)
  g.append('ellipse')
    .attr('class', 'mouth-front')
    .attr('cx', x1)
    .attr('cy', 0)
    .attr('rx', MOUTH_RX - 2.5)
    .attr('ry', MOUTH_RY - 4)
    .attr('fill', '#0b1220')
    .attr('stroke', 'rgba(148,163,184,0.45)')
    .attr('stroke-width', 0.55)

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

  g.select('path.barrel').attr('stroke', hot ? '#e2e8f0' : 'rgba(203,213,225,0.72)').attr('stroke-width', hot ? 1.1 : 0.85)
  g.select('rect.fill')
    .attr('width', fillW)
    .attr('fill', pipe.drops > 0 ? '#fb7185' : '#38bdf8')

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
