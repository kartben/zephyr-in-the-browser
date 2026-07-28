/**
 * Per-queue tube graph for the Trace Queues tab.
 *
 * Each msgq is a horizontal capsule (tube). Putters sit on the left as name
 * pills, getters on the right. Edges attach to vertically spaced ports on each
 * end so arrows stay parallel and never fan into a single point.
 */

import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import {
  flowEdgeId,
  flowThreadLabel,
  queueFlowEvents,
  type QueueFlowEvent,
  type QueueFlowOp,
} from '@/ctf/queueGraph'
import { queueLabel, type QueueSeries, type Trace } from '@/ctf'

const HOT_MS = 1200
const WARM_MS = 4200
const MAX_ANIM_PER_TICK = 12

const PILL_W = 104
const PILL_H = 22
const TUBE_W = 168
/** Capsule height stays fixed so wide tubes never read as circles. */
const TUBE_H = 40
const PORT_GAP = 24
const ROW_GAP = 18
const COL_GAP = 40
const PAD_X = 12
const PAD_Y = 10

type ThreadPill = {
  id: string
  tid: number
  label: string
  x: number
  y: number
  /** Side of its tube. */
  side: 'put' | 'get'
  queueId: number
  /** Index among siblings on this side — drives port Y. */
  port: number
}

type Tube = {
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
  tubes: Tube[]
  pills: ThreadPill[]
  byTube: Map<number, Tube>
  byPill: Map<string, ThreadPill>
}

function pillKey(queueId: number, tid: number, side: 'put' | 'get') {
  return `p:${queueId}:${tid}:${side}`
}

/** Attachment Y on the tube rim — slight spread inside the capsule, not full port gap. */
function tubePortY(tube: Tube, side: 'put' | 'get', port: number): number {
  const n = side === 'put' ? tube.putPorts : tube.getPorts
  const inner = Math.min(PORT_GAP, (TUBE_H - 12) / Math.max(1, n - 1 || 1))
  const span = Math.max(0, (n - 1) * inner)
  return tube.y - span / 2 + port * inner
}

function pillY(tube: Tube, port: number, count: number): number {
  const span = Math.max(0, (count - 1) * PORT_GAP)
  return tube.y - span / 2 + port * PORT_GAP
}

/** Orthogonal-ish path: horizontal from pill, into tube end at port Y. */
function edgePath(
  pill: ThreadPill,
  tube: Tube,
  op: QueueFlowOp,
): { sx: number; sy: number; ex: number; ey: number; mx: number; my: number } {
  const sy = pill.y
  const ey = tubePortY(tube, op === 'put' ? 'put' : 'get', pill.port)
  if (op === 'put') {
    const sx = pill.x + PILL_W / 2
    const ex = tube.x - TUBE_W / 2
    const mx = (sx + ex) / 2
    return { sx, sy, ex, ey, mx, my: (sy + ey) / 2 }
  }
  const sx = tube.x + TUBE_W / 2
  const ex = pill.x - PILL_W / 2
  const mx = (sx + ex) / 2
  return { sx, sy, ex, ey, mx, my: (sy + ey) / 2 }
}

function pathD(p: { sx: number; sy: number; ex: number; ey: number; mx: number }): string {
  // Smooth horizontal connector — mid X shared so siblings stay parallel.
  return `M${p.sx},${p.sy} C${p.mx},${p.sy} ${p.mx},${p.ey} ${p.ex},${p.ey}`
}

function buildLayout(tr: Trace, queues: QueueSeries[], hostW: number): Layout {
  const flow = queueFlowEvents(tr)

  // Per-queue putter / getter sets (successful ops only for membership).
  const putters = new Map<number, number[]>()
  const getters = new Map<number, number[]>()
  for (const q of queues) {
    putters.set(q.id, [])
    getters.set(q.id, [])
  }
  const seenPut = new Map<number, Set<number>>()
  const seenGet = new Map<number, Set<number>>()
  for (const q of queues) {
    seenPut.set(q.id, new Set())
    seenGet.set(q.id, new Set())
  }
  for (const ev of flow) {
    if (!ev.ok || ev.threadId == null) continue
    if (!putters.has(ev.queueId)) continue
    if (ev.op === 'put') {
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
  const tubeX = leftX + PILL_W / 2 + COL_GAP + TUBE_W / 2
  const rightX = tubeX + TUBE_W / 2 + COL_GAP + PILL_W / 2
  const contentW = Math.max(hostW, rightX + PILL_W / 2 + PAD_X)

  const tubes: Tube[] = []
  const pills: ThreadPill[] = []
  let yCursor = PAD_Y + 16

  for (const q of queues) {
    const puts = putters.get(q.id) ?? []
    const gets = getters.get(q.id) ?? []
    // Stable order by name then id.
    const sortT = (ids: number[]) =>
      [...ids].sort((a, b) => {
        const na = flowThreadLabel(tr, a)
        const nb = flowThreadLabel(tr, b)
        return na.localeCompare(nb) || a - b
      })
    const putIds = sortT(puts)
    const getIds = sortT(gets)
    const ports = Math.max(1, putIds.length, getIds.length)
    const bandH = Math.max(TUBE_H + 8, ports * PORT_GAP + 8)
    const cy = yCursor + bandH / 2

    const tube: Tube = {
      id: `q:${q.id}`,
      queueId: q.id,
      label: queueLabel(q),
      cap: q.cap ?? Math.max(1, q.peak),
      depth: q.samples.length ? q.samples[q.samples.length - 1]!.depth : 0,
      drops: q.drops,
      x: tubeX,
      y: cy,
      putPorts: Math.max(1, putIds.length),
      getPorts: Math.max(1, getIds.length),
    }
    tubes.push(tube)

    putIds.forEach((tid, i) => {
      pills.push({
        id: pillKey(q.id, tid, 'put'),
        tid,
        label: flowThreadLabel(tr, tid),
        x: leftX,
        y: pillY(tube, i, putIds.length),
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
        y: pillY(tube, i, getIds.length),
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
    tubes,
    pills,
    byTube: new Map(tubes.map((t) => [t.queueId, t])),
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
    tubes: d3.Selection<SVGGElement, unknown, null, undefined>
    pills: d3.Selection<SVGGElement, unknown, null, undefined>
  } | null>(null)
  const [layoutTick, setLayoutTick] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const svg = d3.select(host).append('svg').attr('class', 'block w-full')
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
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-3.2L7,0L0,3.2')
        .attr('fill', color)
    }
    layersRef.current = {
      labels: svg.append('g'),
      links: svg.append('g'),
      packets: svg.append('g'),
      tubes: svg.append('g'),
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
      layers.tubes.selectAll('*').remove()
      layers.pills.selectAll('*').remove()
      layers.links.selectAll('*').remove()
      layers.labels.selectAll('*').remove()
      svg.attr('viewBox', '0 0 320 120').attr('height', 120)
      return
    }

    const layout = buildLayout(tr, queues, host.clientWidth || 320)
    layoutRef.current = layout
    svg.attr('viewBox', `0 0 ${layout.w} ${layout.h}`).attr('height', layout.h)

    // Column headers
    layers.labels.selectAll('*').remove()
    const headers = [
      { x: PAD_X + PILL_W / 2, t: 'Put' },
      { x: layout.tubes[0]?.x ?? layout.w / 2, t: 'Queue' },
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
        edgeStateRef.current.set(flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }), {
          op: ev.op,
          untilHot: now + 350,
          untilWarm: now + WARM_MS,
          queueId: ev.queueId,
          threadId: ev.threadId!,
        })
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
  const tube = layout.byTube.get(ev.queueId)
  const pill = layout.byPill.get(pillKey(ev.queueId, ev.threadId, ev.op === 'put' ? 'put' : 'get'))
  if (!tube || !pill) return

  const key = flowEdgeId({ threadId: ev.threadId, queueId: ev.queueId, op: ev.op })
  const now = performance.now()
  edgeState.set(key, {
    op: ev.op,
    untilHot: now + HOT_MS,
    untilWarm: now + WARM_MS,
    queueId: ev.queueId,
    threadId: ev.threadId,
  })

  const p = edgePath(pill, tube, ev.op)
  const pkt = packets
    .append('circle')
    .attr('r', 3.2)
    .attr('fill', ev.op === 'put' ? '#93c5fd' : '#fcd34d')
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
    tubes: d3.Selection<SVGGElement, unknown, null, undefined>
    pills: d3.Selection<SVGGElement, unknown, null, undefined>
  },
  layout: Layout,
  edgeState: Map<string, EdgeState>,
) {
  const now = performance.now()
  const active: Array<{
    key: string
    pill: ThreadPill
    tube: Tube
    op: QueueFlowOp
    hot: boolean
  }> = []

  for (const [key, st] of edgeState) {
    if (now > st.untilWarm) {
      edgeState.delete(key)
      continue
    }
    const tube = layout.byTube.get(st.queueId)
    const pill = layout.byPill.get(pillKey(st.queueId, st.threadId, st.op === 'put' ? 'put' : 'get'))
    if (!tube || !pill) continue
    active.push({ key, pill, tube, op: st.op, hot: now < st.untilHot })
  }

  // Also draw cool residual edges for every putter/getter pair (structure).
  const structural: typeof active = []
  for (const pill of layout.pills) {
    const tube = layout.byTube.get(pill.queueId)
    if (!tube) continue
    const op: QueueFlowOp = pill.side === 'put' ? 'put' : 'get'
    const key = flowEdgeId({ threadId: pill.tid, queueId: pill.queueId, op })
    if (active.some((a) => a.key === key)) continue
    structural.push({ key: `struct:${key}`, pill, tube, op, hot: false })
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
    .merge(link)
    .attr('marker-end', (d) =>
      d.key.startsWith('struct:')
        ? null
        : d.op === 'put'
          ? 'url(#qg-arrow-put)'
          : 'url(#qg-arrow-get)',
    )
    .attr('stroke', (d) => (d.op === 'put' ? '#60a5fa' : '#fbbf24'))
    .attr('stroke-width', (d) => (d.key.startsWith('struct:') ? 1 : d.hot ? 2.2 : 1.6))
    .attr('opacity', (d) => (d.key.startsWith('struct:') ? 0.16 : d.hot ? 0.95 : 0.42))
    .attr('d', (d) => pathD(edgePath(d.pill, d.tube, d.op)))

  // Tubes
  const tubeSel = layers.tubes.selectAll<SVGGElement, Tube>('g.tube').data(layout.tubes, (d) => d.id)
  tubeSel.exit().remove()
  const tubeEnter = tubeSel.enter().append('g').attr('class', 'tube')
  tubeEnter
    .append('rect')
    .attr('class', 'shell')
    .attr('rx', 999)
    .attr('fill', 'rgba(96, 165, 250, 0.12)')
    .attr('stroke', '#93c5fd')
  tubeEnter
    .append('rect')
    .attr('class', 'depth')
    .attr('rx', 999)
    .attr('fill', 'rgba(96, 165, 250, 0.45)')
  tubeEnter
    .append('text')
    .attr('class', 'name')
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(248,250,252,0.95)')
    .attr('font-size', 11)
    .attr('font-weight', 600)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
  tubeEnter
    .append('text')
    .attr('class', 'meta')
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(148,163,184,0.9)')
    .attr('font-size', 9)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  const hotQueues = new Set(active.filter((a) => a.hot).map((a) => a.tube.id))
  const tubeMerged = tubeEnter.merge(tubeSel)
  tubeMerged.attr('transform', (d) => `translate(${d.x},${d.y})`)
  tubeMerged.each(function (d) {
    const g = d3.select(this)
    const hot = hotQueues.has(d.id)
    const halfW = TUBE_W / 2
    const halfH = TUBE_H / 2
    const innerPad = 6
    const fillW = Math.max(0, (d.depth / Math.max(1, d.cap)) * (TUBE_W - innerPad * 2))
    g.select('rect.shell')
      .attr('x', -halfW)
      .attr('y', -halfH)
      .attr('width', TUBE_W)
      .attr('height', TUBE_H)
      .attr('stroke-width', hot ? 2.2 : 1.5)
      .attr('fill', hot ? 'rgba(96, 165, 250, 0.22)' : 'rgba(96, 165, 250, 0.12)')
    g.select('rect.depth')
      .attr('x', -halfW + innerPad)
      .attr('y', halfH - 11)
      .attr('height', 6)
      .attr('width', fillW)
    g.select('text.name')
      .attr('y', -3)
      .text(d.label.length > 16 ? `${d.label.slice(0, 15)}…` : d.label)
    g.select('text.meta')
      .attr('y', 11)
      .text(`${d.depth}/${d.cap} · ${d.drops} drop${d.drops === 1 ? '' : 's'}`)
  })

  // Thread pills
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
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 10)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')

  const pillMerged = pillEnter.merge(pillSel)
  pillMerged.attr('transform', (d) => `translate(${d.x},${d.y})`)
  pillMerged.each(function (d) {
    const g = d3.select(this)
    const hot = hotPills.has(d.id)
    const put = d.side === 'put'
    g.select('rect')
      .attr('fill', hot
        ? put
          ? 'rgba(96, 165, 250, 0.28)'
          : 'rgba(251, 191, 36, 0.28)'
        : put
          ? 'rgba(96, 165, 250, 0.1)'
          : 'rgba(251, 191, 36, 0.1)')
      .attr('stroke', put ? '#60a5fa' : '#fbbf24')
      .attr('stroke-width', hot ? 1.8 : 1.2)
    const label = d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label
    g.select('text').attr('fill', 'rgba(248,250,252,0.95)').text(label)
  })
}
