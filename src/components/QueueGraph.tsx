/**
 * Bipartite thread ↔ msgq flow graph for the Trace Queues tab.
 * Fixed layout (producers | queues | consumers); d3 for SVG joins + packet tweens.
 */

import { useEffect, useRef } from 'react'
import * as d3 from 'd3'
import {
  flowEdgeId,
  flowThreadLabel,
  queueFlowEvents,
  threadFlowScores,
  type QueueFlowEvent,
  type QueueFlowOp,
} from '@/ctf/queueGraph'
import { queueLabel, type QueueSeries, type Trace } from '@/ctf'

const HOT_MS = 1200
const WARM_MS = 4200
/** Animate at most this many newly arrived events per paint tick. */
const MAX_ANIM_PER_TICK = 12

type GraphNode = {
  id: string
  kind: 'thread' | 'queue'
  label: string
  tid?: number
  queueId?: number
  cap: number | null
  depth: number
  drops: number
  x: number
  y: number
}

type EdgeState = {
  op: QueueFlowOp
  untilHot: number
  untilWarm: number
}

function linkPath(a: GraphNode, b: GraphNode, op: QueueFlowOp) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy) || 1
  const startPad = a.kind === 'queue' ? 50 : 22
  const endPad = b.kind === 'queue' ? 50 : 22
  const sx = a.x + (dx / dist) * startPad
  const sy = a.y + (dy / dist) * startPad
  const ex = b.x - (dx / dist) * endPad
  const ey = b.y - (dy / dist) * endPad
  const mx = (sx + ex) / 2
  const my = (sy + ey) / 2
  const nx = -dy / dist
  const ny = dx / dist
  const bend = op === 'put' ? 18 : -18
  return { sx, sy, ex, ey, cx: mx + nx * bend, cy: my + ny * bend }
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
  const byIdRef = useRef(new Map<string, GraphNode>())
  const svgRef = useRef<d3.Selection<SVGSVGElement, unknown, null, undefined> | null>(null)
  const layersRef = useRef<{
    labels: d3.Selection<SVGGElement, unknown, null, undefined>
    links: d3.Selection<SVGGElement, unknown, null, undefined>
    packets: d3.Selection<SVGGElement, unknown, null, undefined>
    nodes: d3.Selection<SVGGElement, unknown, null, undefined>
  } | null>(null)

  // Mount SVG once.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const svg = d3.select(host).append('svg').attr('class', 'h-[min(28rem,50vh)] w-full')
    const defs = svg.append('defs')
    for (const [id, color] of [
      ['qg-arrow-put', '#60a5fa'],
      ['qg-arrow-get', '#fbbf24'],
    ] as const) {
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -4 8 8')
        .attr('refX', 7)
        .attr('refY', 0)
        .attr('markerWidth', 7)
        .attr('markerHeight', 7)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-3.5L8,0L0,3.5')
        .attr('fill', color)
    }
    layersRef.current = {
      labels: svg.append('g'),
      links: svg.append('g'),
      packets: svg.append('g'),
      nodes: svg.append('g'),
    }
    svgRef.current = svg

    const ro = new ResizeObserver(() => {
      // Parent effect will re-render on next event; force a layout pass via custom event.
      host.dispatchEvent(new Event('qg-resize'))
    })
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

    const flow = queueFlowEvents(tr)
    if (queues.length === 0) {
      layers.nodes.selectAll('*').remove()
      layers.links.selectAll('*').remove()
      layers.labels.selectAll('*').remove()
      return
    }

    const scores = threadFlowScores(flow)
    const threadIds = [...scores.keys()].sort((a, b) => a - b)

    const w = Math.max(320, host.clientWidth)
    const h = Math.max(220, Math.min(448, host.clientHeight || 320))
    svg.attr('viewBox', `0 0 ${w} ${h}`)

    const top = 28
    const usable = h - top - 16
    const leftIds = threadIds.filter((id) => (scores.get(id) ?? 0) >= 0)
    const rightIds = threadIds.filter((id) => (scores.get(id) ?? 0) < 0)

    const nodes: GraphNode[] = []
    leftIds.forEach((tid, i) => {
      nodes.push({
        id: `t:${tid}`,
        kind: 'thread',
        label: flowThreadLabel(tr, tid),
        tid,
        cap: null,
        depth: 0,
        drops: 0,
        x: w * 0.14,
        y: top + ((i + 0.5) * usable) / Math.max(1, leftIds.length),
      })
    })
    rightIds.forEach((tid, i) => {
      nodes.push({
        id: `t:${tid}`,
        kind: 'thread',
        label: flowThreadLabel(tr, tid),
        tid,
        cap: null,
        depth: 0,
        drops: 0,
        x: w * 0.86,
        y: top + ((i + 0.5) * usable) / Math.max(1, rightIds.length),
      })
    })
    queues.forEach((q, i) => {
      nodes.push({
        id: `q:${q.id}`,
        kind: 'queue',
        label: queueLabel(q),
        queueId: q.id,
        cap: q.cap ?? Math.max(1, q.peak),
        depth: q.samples.length ? q.samples[q.samples.length - 1]!.depth : 0,
        drops: q.drops,
        x: w * 0.5,
        y: top + ((i + 0.5) * usable) / Math.max(1, queues.length),
      })
    })

    const byId = new Map(nodes.map((n) => [n.id, n]))
    byIdRef.current = byId

    // Column headers
    layers.labels.selectAll('*').remove()
    const col = layers.labels
      .selectAll('text')
      .data([
        { x: w * 0.14, t: 'Producers' },
        { x: w * 0.5, t: 'Queues' },
        { x: w * 0.86, t: 'Consumers' },
      ])
    col
      .enter()
      .append('text')
      .attr('fill', 'rgba(148,163,184,0.75)')
      .attr('font-size', 9)
      .attr('font-weight', 600)
      .attr('letter-spacing', '0.08em')
      .attr('text-anchor', 'middle')
      .attr('y', 14)
      .attr('x', (d) => d.x)
      .text((d) => d.t.toUpperCase())

    // Animate newly arrived successful flow events.
    const newest = flow.filter((ev) => ev.index > lastIndexRef.current)
    const firstPaint = lastIndexRef.current < 0
    if (newest.length) {
      lastIndexRef.current = flow[flow.length - 1]!.index
      const toAnim = newest.filter((ev) => ev.ok && ev.threadId != null).slice(-MAX_ANIM_PER_TICK)
      for (const ev of toAnim) firePacket(ev, byId, layers.packets, edgeStateRef.current)
    } else if (firstPaint) {
      // Seed warm edges from recent history so opening the tab isn't blank.
      lastIndexRef.current = flow.length ? flow[flow.length - 1]!.index : -1
      const recent = flow.filter((ev) => ev.ok && ev.threadId != null).slice(-8)
      const now = performance.now()
      for (const ev of recent) {
        const key = `${ev.threadId}|${ev.queueId}|${ev.op}`
        edgeStateRef.current.set(key, {
          op: ev.op,
          untilHot: now + 400,
          untilWarm: now + WARM_MS,
        })
      }
    }

    paintFrame(layers, nodes, byId, edgeStateRef.current)

    const onResize = () => {
      // Re-run this effect's layout by depending on nothing — call paint with fresh size next tick.
    }
    host.addEventListener('qg-resize', onResize)
    const interval = window.setInterval(() => {
      paintFrame(layers, nodes, byIdRef.current, edgeStateRef.current)
    }, 180)

    return () => {
      host.removeEventListener('qg-resize', onResize)
      window.clearInterval(interval)
    }
  }, [tr, queues, eventCount])

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded border border-border/60 bg-slate-950/40"
      style={{ minHeight: 220 }}
    />
  )
}

function firePacket(
  ev: QueueFlowEvent,
  byId: Map<string, GraphNode>,
  packets: d3.Selection<SVGGElement, unknown, null, undefined>,
  edgeState: Map<string, EdgeState>,
) {
  if (ev.threadId == null) return
  const thread = byId.get(`t:${ev.threadId}`)
  const queue = byId.get(`q:${ev.queueId}`)
  if (!thread || !queue) return
  const a = ev.op === 'put' ? thread : queue
  const b = ev.op === 'put' ? queue : thread
  const key = flowEdgeId({ threadId: ev.threadId, queueId: ev.queueId, op: ev.op })
  const now = performance.now()
  edgeState.set(key, { op: ev.op, untilHot: now + HOT_MS, untilWarm: now + WARM_MS })

  const p = linkPath(a, b, ev.op)
  const pkt = packets
    .append('circle')
    .attr('r', 3.5)
    .attr('fill', ev.op === 'put' ? '#93c5fd' : '#fcd34d')
    .attr('cx', p.sx)
    .attr('cy', p.sy)
  pkt
    .transition()
    .duration(520)
    .ease(d3.easeCubicOut)
    .attrTween('cx', () => (t) => {
      const u = 1 - t
      return String(u * u * p.sx + 2 * u * t * p.cx + t * t * p.ex)
    })
    .attrTween('cy', () => (t) => {
      const u = 1 - t
      return String(u * u * p.sy + 2 * u * t * p.cy + t * t * p.ey)
    })
    .attr('opacity', 0.1)
    .remove()
}

function paintFrame(
  layers: {
    links: d3.Selection<SVGGElement, unknown, null, undefined>
    nodes: d3.Selection<SVGGElement, unknown, null, undefined>
  },
  nodes: GraphNode[],
  byId: Map<string, GraphNode>,
  edgeState: Map<string, EdgeState>,
) {
  const now = performance.now()
  const active: Array<{
    key: string
    a: GraphNode
    b: GraphNode
    op: QueueFlowOp
    hot: boolean
  }> = []
  for (const [key, st] of edgeState) {
    if (now > st.untilWarm) {
      edgeState.delete(key)
      continue
    }
    const [tid, qid, op] = key.split('|') as [string, string, QueueFlowOp]
    const a =
      op === 'put' ? byId.get(`t:${tid}`) : byId.get(`q:${qid}`)
    const b =
      op === 'put' ? byId.get(`q:${qid}`) : byId.get(`t:${tid}`)
    if (!a || !b) continue
    active.push({ key, a, b, op, hot: now < st.untilHot })
  }

  const link = layers.links.selectAll<SVGPathElement, (typeof active)[0]>('path').data(active, (d) => d.key)
  link.exit().remove()
  link
    .enter()
    .append('path')
    .attr('fill', 'none')
    .attr('stroke-linecap', 'round')
    .attr('marker-end', (d) => (d.op === 'put' ? 'url(#qg-arrow-put)' : 'url(#qg-arrow-get)'))
    .merge(link)
    .attr('stroke', (d) => (d.op === 'put' ? '#60a5fa' : '#fbbf24'))
    .attr('stroke-width', (d) => (d.hot ? 2.4 : 1.5))
    .attr('opacity', (d) => (d.hot ? 0.95 : 0.38))
    .attr('d', (d) => {
      const p = linkPath(d.a, d.b, d.op)
      return `M${p.sx},${p.sy} Q${p.cx},${p.cy} ${p.ex},${p.ey}`
    })

  const sel = layers.nodes.selectAll<SVGGElement, GraphNode>('g.node').data(nodes, (d) => d.id)
  sel.exit().remove()
  const enter = sel.enter().append('g').attr('class', (d) => `node ${d.kind}`)

  const th = enter.filter((d) => d.kind === 'thread')
  th.append('circle')
    .attr('r', 18)
    .attr('fill', 'rgba(125, 211, 192, 0.14)')
    .attr('stroke', '#7dd3c0')
    .attr('stroke-width', 1.6)
  th.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('fill', 'rgba(248,250,252,0.95)')
    .attr('font-size', 10)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  const qn = enter.filter((d) => d.kind === 'queue')
  qn.append('rect')
    .attr('class', 'shell')
    .attr('width', 96)
    .attr('height', 44)
    .attr('x', -48)
    .attr('y', -22)
    .attr('rx', 8)
    .attr('fill', 'rgba(96, 165, 250, 0.16)')
    .attr('stroke', '#93c5fd')
    .attr('stroke-width', 1.6)
  qn.append('rect').attr('class', 'depth').attr('x', -40).attr('y', 4).attr('height', 8).attr('rx', 3).attr('fill', 'rgba(96, 165, 250, 0.55)')
  qn.append('line')
    .attr('class', 'cap')
    .attr('y1', 4)
    .attr('y2', 12)
    .attr('stroke', '#f43f5e')
    .attr('stroke-dasharray', '4 3')
    .attr('stroke-width', 1)
    .attr('opacity', 0.75)
  qn.append('text')
    .attr('class', 'name')
    .attr('x', -40)
    .attr('y', -14)
    .attr('fill', 'rgba(248,250,252,0.95)')
    .attr('font-size', 10)
    .attr('font-weight', 600)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
  qn.append('text')
    .attr('class', 'meta')
    .attr('x', -40)
    .attr('y', -1)
    .attr('fill', 'rgba(148,163,184,0.9)')
    .attr('font-size', 9)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  const hotIds = new Set<string>()
  for (const d of active) {
    if (d.hot) {
      hotIds.add(d.a.id)
      hotIds.add(d.b.id)
    }
  }

  const merged = enter.merge(sel)
  merged.attr('transform', (d) => `translate(${d.x},${d.y})`)
  merged
    .filter((d) => d.kind === 'thread')
    .select('text')
    .text((d) => (d.label.length > 8 ? `${d.label.slice(0, 7)}…` : d.label))
  merged
    .filter((d) => d.kind === 'thread')
    .select('circle')
    .attr('stroke-width', (d) => (hotIds.has(d.id) ? 2.4 : 1.6))
    .attr('fill', (d) =>
      hotIds.has(d.id) ? 'rgba(125, 211, 192, 0.32)' : 'rgba(125, 211, 192, 0.14)',
    )
  merged.filter((d) => d.kind === 'queue').each(function (d) {
    const g = d3.select(this)
    const cap = Math.max(1, d.cap ?? 1)
    g.select('rect.depth').attr('width', Math.max(0, (d.depth / cap) * 80))
    g.select('line.cap').attr('x1', 40).attr('x2', 40)
    g.select('text.name').text(d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label)
    g.select('text.meta').text(`${d.depth}/${cap} · ${d.drops} drops`)
    g.select('rect.shell')
      .attr('stroke-width', hotIds.has(d.id) ? 2.4 : 1.6)
      .attr('fill', hotIds.has(d.id) ? 'rgba(96, 165, 250, 0.28)' : 'rgba(96, 165, 250, 0.16)')
  })
}
