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
  advanceFlowCursor,
  flowEdgeId,
  flowThreadLabel,
  isPutOp,
  queueFlowEvents,
  threadFlowScores,
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
/** Tall enough for up to four side ports without stacking tips. */
const PILL_H = 32
const PILL_PAD_X = 10
/** Fixed attachment slots on each east/west pill edge. */
const THREAD_SIDE_PORTS = 4
/** Vertical span used by the outermost side ports. */
const THREAD_PORT_SPAN = PILL_H - 10
/** Barrel length between mouth centers. */
const PIPE_W = 224
/** Fixed cylinder height — ports attach near the bore centerline. */
const PIPE_H = 44
/** Horizontal radius of the mouth ellipses (perspective end-caps). */
const MOUTH_RX = 10
/** Vertical radius — must match the barrel half-height so rails meet the caps. */
const MOUTH_RY = PIPE_H / 2
const COL_GAP = 48
const PAD_X = 16
const PAD_Y = 8
/** Extra top clearance for put_front arcs over the barrel. */
const ARC_CLEAR = 28
/** Keeps put_front rails clear of the top edge. */
const DETOUR_HEADROOM = 36
/** Vertical gap between stacked pipes — must leave a clear routing channel. */
const RANK_GAP = PIPE_H + ARC_CLEAR + 56
/** Minimum gap between thread pills on the same side. */
const SIDE_GAP = PILL_H + 18
const ARROW_LEN = 11
const ARROW_W = 10
/** How far wrap-around rails stand off from a mouth. */
const RAIL_STANDOFF = 36

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
  /** Index into the queue mouth fan (top→bottom). */
  port: number
  /** Index into the thread pill’s east/west side ports (top→bottom). */
  threadPort: number
  /** How many links share this thread’s attachment side (for spacing). */
  threadPortCount: number
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
  scene: d3.Selection<SVGGElement, unknown, null, undefined>
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
 * Which pill edge an edge uses. Puts leave toward the pipe; gets arrive from it.
 */
function threadAttachSide(
  thread: ThreadNode,
  pipe: Pipe,
  op: QueueFlowOp,
): 'east' | 'west' {
  if (op === 'get') return thread.x >= pipe.x ? 'west' : 'east'
  return thread.x <= pipe.x ? 'east' : 'west'
}

/** Y of side-port `port` among `count` live ports, centered on the pill. */
function threadPortY(thread: ThreadNode, port: number, count: number): number {
  const n = Math.max(1, Math.min(THREAD_SIDE_PORTS, count))
  const slot = Math.max(0, Math.min(n - 1, port))
  if (n <= 1) return thread.y
  const step = THREAD_PORT_SPAN / (THREAD_SIDE_PORTS - 1)
  const span = step * (n - 1)
  return thread.y - span / 2 + slot * step
}

function threadEdgePoint(
  thread: ThreadNode,
  side: 'east' | 'west',
  port: number,
  portCount: number,
): RoutePoint {
  return {
    x: thread.x + (side === 'east' ? PILL_W / 2 : -PILL_W / 2),
    y: threadPortY(thread, port, portCount),
  }
}

/**
 * Assign threadPort indices per pill side so co-located arrows fan across the
 * east/west edge instead of sharing one midpoint.
 */
function assignThreadPorts(links: FlowLink[], byThread: Map<number, ThreadNode>, byPipe: Map<number, Pipe>) {
  type Key = string
  const groups = new Map<Key, FlowLink[]>()
  for (const link of links) {
    const thread = byThread.get(link.threadId)
    const pipe = byPipe.get(link.queueId)
    if (!thread || !pipe) continue
    const side = threadAttachSide(thread, pipe, link.op)
    const key = `${link.threadId}:${side}`
    const bucket = groups.get(key) ?? []
    bucket.push(link)
    groups.set(key, bucket)
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const pa = byPipe.get(a.queueId)?.y ?? 0
      const pb = byPipe.get(b.queueId)?.y ?? 0
      if (pa !== pb) return pa - pb
      // Stable: put before put_front before get when same queue.
      const order = { put: 0, put_front: 1, get: 2 } as const
      return order[a.op] - order[b.op] || a.id.localeCompare(b.id)
    })
    const count = Math.min(THREAD_SIDE_PORTS, group.length)
    group.forEach((link, i) => {
      // Overflowing links share the last slot rather than spilling off the pill.
      link.threadPort = Math.min(i, THREAD_SIDE_PORTS - 1)
      link.threadPortCount = count
    })
  }
}

/**
 * Attach at the thread’s height when it falls inside the mouth; otherwise clamp
 * to the aperture. Avoids reflowing every lane when putPorts/getPorts grows.
 */
function clampMouthY(pipe: Pipe, preferredY: number): number {
  const lo = pipe.y - MOUTH_RY + 4
  const hi = pipe.y + MOUTH_RY - 4
  return Math.max(lo, Math.min(hi, preferredY))
}

/**
 * put_front shares the physical front mouth with get. Give inserts their own
 * entry lanes so their arrows do not sit directly on top of outgoing gets.
 * Port 0 is the topmost insert lane.
 */
function frontInsertY(pipe: Pipe, port: number): number {
  const count = Math.max(1, pipe.putPorts)
  if (count <= 1) return pipe.y - Math.min(8, MOUTH_RY * 0.45)
  const usable = Math.min(10, MOUTH_RY - 5)
  return pipe.y - usable + (port / Math.max(1, count - 1)) * usable * 2
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

type Obstacle = {
  id: string
  left: number
  right: number
  top: number
  bottom: number
}

/** Corner radius for orthogonal rails. */
const RAIL_RADIUS = 12
/**
 * Straight run into / out of a mouth after the last elbow. Must clear the
 * arrowhead length so the tip stays horizontal when it meets the aperture.
 */
const MOUTH_APPROACH = Math.max(RAIL_RADIUS + ARROW_LEN, 28)
/** Padding around a tube that edges must not enter. */
const OBSTACLE_PAD = 4

/**
 * Barrel body as an obstacle. Mouth lips sit just outside left/right so a
 * final stub into the aperture is legal; crossing the bore is not.
 */
function pipeObstacle(pipe: Pipe): Obstacle {
  return {
    id: pipe.id,
    left: pipe.x - PIPE_W / 2 + MOUTH_RX * 0.35,
    right: pipe.x + PIPE_W / 2 - MOUTH_RX * 0.35,
    top: pipe.y - PIPE_H / 2 - OBSTACLE_PAD,
    bottom: pipe.y + PIPE_H / 2 + OBSTACLE_PAD,
  }
}

function segHitsObstacle(a: RoutePoint, b: RoutePoint, obs: Obstacle): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  if (Math.abs(a.y - b.y) < 0.5) {
    // Horizontal
    if (a.y < obs.top || a.y > obs.bottom) return false
    return maxX >= obs.left && minX <= obs.right
  }
  if (Math.abs(a.x - b.x) < 0.5) {
    // Vertical
    if (a.x < obs.left || a.x > obs.right) return false
    return maxY >= obs.top && minY <= obs.bottom
  }
  // Non-ortho: treat as hit if the bbox overlaps (shouldn't happen).
  return maxX >= obs.left && minX <= obs.right && maxY >= obs.top && minY <= obs.bottom
}

function pathHitsObstacles(points: RoutePoint[], obstacles: Obstacle[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    for (const obs of obstacles) {
      if (segHitsObstacle(a, b, obs)) return true
    }
  }
  return false
}

/** Horizontal gutters above / between / below tubes — the only legal east-west rails. */
function channelYs(obstacles: Obstacle[]): number[] {
  if (!obstacles.length) return []
  const sorted = [...obstacles].sort((a, b) => a.top - b.top)
  const channels: number[] = [sorted[0]!.top - RAIL_STANDOFF]
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1]!.top - sorted[i]!.bottom
    if (gap >= 12) channels.push(sorted[i]!.bottom + gap / 2)
  }
  channels.push(sorted.at(-1)!.bottom + RAIL_STANDOFF)
  return channels
}

function westCorridorX(obstacles: Obstacle[]): number {
  if (!obstacles.length) return 0
  return Math.min(...obstacles.map((o) => o.left)) - RAIL_STANDOFF
}

function eastCorridorX(obstacles: Obstacle[]): number {
  if (!obstacles.length) return 0
  return Math.max(...obstacles.map((o) => o.right)) + RAIL_STANDOFF
}

function nearestChannel(y: number, channels: number[]): number {
  if (!channels.length) return y
  return channels.reduce((best, ch) => (Math.abs(ch - y) < Math.abs(best - y) ? ch : best), channels[0]!)
}

/**
 * Orthogonal polyline with quadratic rounded elbows. Final segment is always a
 * straight `L` into the target so arrowheads line up with the stroke.
 */
function roundedOrtho(points: RoutePoint[]): EdgePath {
  if (points.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 }
    return { sx: p.x, sy: p.y, ex: p.x, ey: p.y, d: '' }
  }
  const pts: RoutePoint[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!
    const prev = pts.at(-1)!
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) pts.push(p)
  }
  if (pts.length < 2) {
    const p = pts[0]!
    return { sx: p.x, sy: p.y, ex: p.x, ey: p.y, d: '' }
  }
  const start = pts[0]!
  const end = pts.at(-1)!
  let d = `M${start.x},${start.y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!
    const cur = pts[i]!
    const next = pts[i + 1]!
    const inDx = cur.x - prev.x
    const inDy = cur.y - prev.y
    const outDx = next.x - cur.x
    const outDy = next.y - cur.y
    const inLen = Math.hypot(inDx, inDy)
    const outLen = Math.hypot(outDx, outDy)
    if (inLen < 1e-3 || outLen < 1e-3) continue
    const r = Math.min(RAIL_RADIUS, inLen / 2, outLen / 2)
    const before = { x: cur.x - (inDx / inLen) * r, y: cur.y - (inDy / inLen) * r }
    const after = { x: cur.x + (outDx / outLen) * r, y: cur.y + (outDy / outLen) * r }
    d += `L${before.x},${before.y}Q${cur.x},${cur.y} ${after.x},${after.y}`
  }
  d += `L${end.x},${end.y}`
  return { sx: start.x, sy: start.y, ex: end.x, ey: end.y, d }
}

/**
 * Outside standoff just before a mouth so the final (or first) stroke is a
 * straight horizontal stub long enough for the arrowhead.
 * `fromSide` is the side the wire occupies relative to the lip (west of an
 * end mouth, east of a front mouth).
 */
function mouthApproachPoint(mouth: RoutePoint, fromSide: 'east' | 'west'): RoutePoint {
  const dx = fromSide === 'east' ? MOUTH_APPROACH : -MOUTH_APPROACH
  return { x: mouth.x + dx, y: mouth.y }
}

/**
 * Short orthogonal routes that skip tubes. Tries the fewest bends first.
 * `mouthAt` forces a horizontal stub at the tube aperture: puts enter into
 * `end`, gets leave from `start`. Vertical dives into / out of a mouth are
 * never chosen — that is what made arrows look like they stabbed the tube.
 * `mouthSide` is which side of the lip the stub lives on.
 */
function routeAvoidingTubes(
  start: RoutePoint,
  end: RoutePoint,
  obstacles: Obstacle[],
  prefer: 'hvh' | 'east' | 'west',
  mouthAt: 'start' | 'end',
  mouthSide: 'east' | 'west',
): EdgePath {
  const tryPath = (points: RoutePoint[]) =>
    pathHitsObstacles(points, obstacles) ? null : roundedOrtho(points)

  const eastX = eastCorridorX(obstacles)
  const westX = westCorridorX(obstacles)
  const ch = nearestChannel((start.y + end.y) / 2, channelYs(obstacles))
  // Rails hug the mouth's outside — end mouths use west, front mouths east.
  const sideX = mouthSide === 'west' ? westX : eastX

  if (mouthAt === 'end') {
    const approach = mouthApproachPoint(end, mouthSide)
    // Prefer the shared side corridor when it is farther out than the stub.
    if (mouthSide === 'east') approach.x = Math.max(approach.x, eastX)
    else approach.x = Math.min(approach.x, westX)

    // 1. Horizontal into mouth: rise/drop at start, then run to the lip.
    const flat = tryPath([start, { x: start.x, y: end.y }, approach, end])
    if (flat) return flat

    // 2. Side corridor at start height, then drop/rise to mouth height.
    const elbow = tryPath([start, { x: approach.x, y: start.y }, approach, end])
    if (elbow) return elbow

    // 3. Channel wrap, always finishing on the horizontal approach stub.
    const wrap = tryPath([
      start,
      { x: sideX, y: start.y },
      { x: sideX, y: ch },
      { x: approach.x, y: ch },
      approach,
      end,
    ])
    if (wrap) return wrap

    // Cross-side (right-column thread → left/end mouth).
    if (prefer === 'west' || mouthSide === 'west') {
      const cross = tryPath([
        start,
        { x: eastX, y: start.y },
        { x: eastX, y: ch },
        { x: westX, y: ch },
        { x: approach.x, y: ch },
        approach,
        end,
      ])
      if (cross) return cross
    }

    // put_front from the left: over the barrels, then east corridor → lip.
    if (prefer === 'east' || mouthSide === 'east') {
      const over = tryPath([
        start,
        { x: start.x, y: ch },
        { x: approach.x, y: ch },
        approach,
        end,
      ])
      if (over) return over
    }

    return roundedOrtho([start, { x: approach.x, y: start.y }, approach, end])
  }

  // mouthAt === 'start' (get): leave the front mouth horizontally first.
  const leave = mouthApproachPoint(start, mouthSide)
  if (mouthSide === 'east') leave.x = Math.max(leave.x, eastX)
  else leave.x = Math.min(leave.x, westX)

  // 1. Horizontal exit, then bend toward the thread.
  const flat = tryPath([start, leave, { x: end.x, y: start.y }, end])
  if (flat) return flat

  const elbow = tryPath([start, leave, { x: leave.x, y: end.y }, end])
  if (elbow) return elbow

  const wrap = tryPath([
    start,
    leave,
    { x: leave.x, y: ch },
    { x: sideX, y: ch },
    { x: sideX, y: end.y },
    end,
  ])
  if (wrap) return wrap

  if (prefer === 'east' || mouthSide === 'east') {
    const over = tryPath([
      start,
      leave,
      { x: leave.x, y: ch },
      { x: end.x, y: ch },
      end,
    ])
    if (over) return over
  }

  return roundedOrtho([start, leave, { x: leave.x, y: end.y }, end])
}

function edgePath(
  thread: ThreadNode,
  pipe: Pipe,
  link: FlowLink,
  pipes: Pipe[],
): EdgePath {
  const { op } = link
  const obstacles = pipes.map(pipeObstacle)
  const side = threadAttachSide(thread, pipe, op)
  const tip = threadEdgePoint(thread, side, link.threadPort, link.threadPortCount)

  if (op === 'put_front') {
    const ey = frontInsertY(pipe, link.port)
    const end = { x: mouthLipX(pipe, 'front', ey), y: ey }
    return routeAvoidingTubes(tip, end, obstacles, 'east', 'end', 'east')
  }

  if (op === 'put') {
    const ey = clampMouthY(pipe, tip.y)
    const end = { x: mouthLipX(pipe, 'end', ey), y: ey }
    return routeAvoidingTubes(tip, end, obstacles, tip.x <= end.x ? 'hvh' : 'west', 'end', 'west')
  }

  const ey = clampMouthY(pipe, tip.y)
  const start = { x: mouthLipX(pipe, 'front', ey), y: ey }
  const leaveSide: 'east' | 'west' = tip.x >= start.x ? 'east' : 'west'
  return routeAvoidingTubes(start, tip, obstacles, leaveSide === 'east' ? 'hvh' : 'east', 'start', leaveSide)
}

function burstBadgePosition(thread: ThreadNode, pipe: Pipe, link: FlowLink, pipes: Pipe[]) {
  const { op } = link
  if (op === 'put_front') {
    const y = nearestChannel(pipe.y - PIPE_H / 2 - ARC_CLEAR, channelYs(pipes.map(pipeObstacle)))
    return { x: pipe.x, y: y - 8 }
  }
  const side = threadAttachSide(thread, pipe, op)
  const tip = threadEdgePoint(thread, side, link.threadPort, link.threadPortCount)
  const attachY = clampMouthY(pipe, tip.y)
  const fromX = op === 'get' ? pipeFrontX(pipe) : tip.x
  const toX = op === 'get' ? tip.x : pipeEndX(pipe)
  return { x: (fromX + toX) / 2, y: (tip.y + attachY) / 2 - 9 }
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
    // Port indices filled after placement so mouth + thread fans match Y order.
    links.push({ id, threadId: ev.threadId!, queueId: ev.queueId, op: ev.op, port: 0, threadPort: 0, threadPortCount: 1 })
  }

  // Pipe Y follows the caller’s queue order (sortQueuesByPipelineOrder) so the
  // topology spine matches the depth-chart rows top-to-bottom. Threads sit
  // beside the mouths they use (putters west / getters east).
  const leftX = PAD_X + PILL_W / 2
  const pipeSpineX = leftX + PILL_W / 2 + COL_GAP + PIPE_W / 2
  const rightX = pipeSpineX + PIPE_W / 2 + COL_GAP + PILL_W / 2

  const pipePos = new Map<string, { x: number; y: number }>()
  queues.forEach((q, row) => {
    pipePos.set(`q:${q.id}`, {
      x: pipeSpineX,
      y: PAD_Y + DETOUR_HEADROOM + row * RANK_GAP + PIPE_H / 2,
    })
  })

  const pipes = queues.map((q) => {
    const pos = pipePos.get(`q:${q.id}`)!
    return {
      id: `q:${q.id}`,
      queueId: q.id,
      label: queueLabel(q),
      cap: q.cap ?? Math.max(1, q.peak),
      depth: q.samples.length ? q.samples[q.samples.length - 1]!.depth : 0,
      drops: q.drops,
      x: pos.x,
      y: pos.y,
      putPorts: Math.max(1, puts.get(q.id)!.length),
      getPorts: Math.max(1, gets.get(q.id)!.length),
    }
  })
  const byPipe = new Map(pipes.map((p) => [p.queueId, p]))

  const scores = threadFlowScores(valid)
  type Side = 'left' | 'right'
  type Draft = { tid: number; side: Side; y: number; anchorKey: string; label: string }
  const draft: Draft[] = threadIds.map((tid) => {
    const mine = links.filter((link) => link.threadId === tid)
    const label = flowThreadLabel(tr, tid)
    const score = scores.get(tid) ?? 0
    const hasGet = mine.some((link) => link.op === 'get')
    const hasPut = mine.some((link) => isPutOp(link.op))
    // Mouth affinity: end is west, front is east. Bridge threads (put+get) sit
    // on the consumer/front side so get edges stay short.
    let side: Side
    if (hasGet && hasPut) side = 'right'
    else if (score > 0 || (hasPut && !hasGet)) side = 'left'
    else side = 'right'

    // Anchor to the primary queue on that side so co-producers / co-consumers
    // stack together instead of all collapsing to the same mean Y.
    const primary = mine
      .filter((link) => (side === 'left' ? isPutOp(link.op) : link.op === 'get'))
      .sort((a, b) => a.queueId - b.queueId)[0]
      ?? mine[0]
    const anchorPipe = primary ? byPipe.get(primary.queueId) : undefined
    const ys = mine.map((link) => byPipe.get(link.queueId)?.y).filter((y): y is number => y != null)
    const y = anchorPipe?.y ?? (ys.length ? (d3.mean(ys) ?? PAD_Y + DETOUR_HEADROOM) : PAD_Y + DETOUR_HEADROOM)
    const anchorKey = `${side}:${primary?.queueId ?? 'none'}`
    return { tid, side, y, anchorKey, label }
  })

  // Stack each producer/consumer family on its pipe, ordered by label so the
  // vertical order is stable and matches mouth port order (no criss-cross).
  for (const group of d3.groups(draft, (node) => node.anchorKey)) {
    const members = group[1].sort((a, b) => a.label.localeCompare(b.label) || a.tid - b.tid)
    const anchorY = members[0]?.y ?? PAD_Y + DETOUR_HEADROOM
    members.forEach((node, i) => {
      node.y = anchorY + (i - (members.length - 1) / 2) * SIDE_GAP
    })
  }

  for (const side of ['left', 'right'] as const) {
    const group = draft.filter((node) => node.side === side).sort((a, b) => a.y - b.y || a.label.localeCompare(b.label) || a.tid - b.tid)
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]!
      const cur = group[i]!
      if (cur.y - prev.y < SIDE_GAP) cur.y = prev.y + SIDE_GAP
    }
  }

  const threads = draft.map((node) => ({
    id: `t:${node.tid}`,
    tid: node.tid,
    label: node.label,
    x: node.side === 'left' ? leftX : rightX,
    y: node.y,
  }))
  const byThread = new Map(threads.map((t) => [t.tid, t]))

  // Mouth ports follow visual top→bottom order so edges to the same aperture
  // never cross when threads are already sorted on their side.
  const assignPorts = (pred: (link: FlowLink) => boolean) => {
    const grouped = d3.group(links.filter(pred), (link) => link.queueId)
    for (const [, group] of grouped) {
      group.sort((a, b) => {
        const ay = byThread.get(a.threadId)?.y ?? 0
        const by = byThread.get(b.threadId)?.y ?? 0
        return ay - by || a.threadId - b.threadId
      })
      group.forEach((link, port) => {
        link.port = port
      })
    }
  }
  assignPorts((link) => isPutOp(link.op))
  assignPorts((link) => link.op === 'get')
  assignThreadPorts(links, byThread, byPipe)

  const maxThreadY = threads.reduce((m, t) => Math.max(m, t.y), 0)
  const maxPipeY = pipes.reduce((m, p) => Math.max(m, p.y), 0)
  const contentW = Math.max(hostW, rightX + PILL_W / 2 + PAD_X)
  const contentH = Math.max(120, PAD_Y + Math.max(maxThreadY + PILL_H / 2, maxPipeY + PIPE_H / 2 + 14) + PAD_Y)
  return { w: contentW, h: contentH, pipes, threads, links, byPipe, byThread }
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
  const positionOverridesRef = useRef(new Map<string, { x: number; y: number }>())
  const threadDragRef = useRef<d3.DragBehavior<SVGGElement, ThreadNode, ThreadNode | d3.SubjectPosition> | null>(null)
  const pipeDragRef = useRef<d3.DragBehavior<SVGGElement, Pipe, Pipe | d3.SubjectPosition> | null>(null)
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

    const scene = svg.append('g').attr('class', 'queue-graph-scene')
    const layers: Layers = {
      scene,
      links: scene.append('g'),
      packets: scene.append('g'),
      pipes: scene.append('g'),
      pills: scene.append('g'),
    }
    layersRef.current = layers
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.35, 3])
        .on('zoom', (event) => scene.attr('transform', event.transform.toString())),
    )

    const move = (event: d3.D3DragEvent<SVGGElement, ThreadNode | Pipe, unknown>, d: ThreadNode | Pipe) => {
      const svgNode = svg.node()
      if (!svgNode) return
      const [screenX, screenY] = d3.pointer(event.sourceEvent, svgNode)
      const transform = d3.zoomTransform(svgNode)
      d.x = transform.invertX(screenX)
      d.y = transform.invertY(screenY)
      positionOverridesRef.current.set(d.id, { x: d.x, y: d.y })
      layers.pipes
        .selectAll<SVGGElement, Pipe>('g.pipe')
        .filter((candidate) => candidate.id === d.id)
        .attr('transform', `translate(${d.x},${d.y})`)
      if (layoutRef.current) paintFrame(layers, layoutRef.current, edgeStateRef.current, threadDragRef.current)
    }
    threadDragRef.current = d3.drag<SVGGElement, ThreadNode>().on('drag', function (event, d) { move(event, d) })
    pipeDragRef.current = d3.drag<SVGGElement, Pipe>().on('drag', function (event, d) { move(event, d) })
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
      svg.attr('viewBox', '0 0 320 100').attr('height', 100)
      return
    }

    const layout = buildLayout(tr, queues, host.clientWidth || 320)
    const liveIds = new Set([...layout.pipes, ...layout.threads].map((node) => node.id))
    for (const id of [...positionOverridesRef.current.keys()]) {
      if (!liveIds.has(id)) positionOverridesRef.current.delete(id)
    }
    // Only user drags stick — auto-freeze was locking nodes on the wrong side
    // and forcing the router into long wraps.
    for (const node of [...layout.pipes, ...layout.threads]) {
      const dragged = positionOverridesRef.current.get(node.id)
      if (dragged) Object.assign(node, dragged)
    }
    // Re-assign mouth ports from the (possibly dragged) thread Y order so a
    // pinned stack can’t drift out of sync with aperture lanes.
    const assignPorts = (pred: (link: FlowLink) => boolean) => {
      const grouped = d3.group(layout.links.filter(pred), (link) => link.queueId)
      for (const [, group] of grouped) {
        group.sort((a, b) => {
          const ay = layout.byThread.get(a.threadId)?.y ?? 0
          const by = layout.byThread.get(b.threadId)?.y ?? 0
          return ay - by || a.threadId - b.threadId
        })
        group.forEach((link, port) => {
          link.port = port
        })
      }
    }
    assignPorts((link) => isPutOp(link.op))
    assignPorts((link) => link.op === 'get')
    assignThreadPorts(layout.links, layout.byThread, layout.byPipe)

    layoutRef.current = layout
    svg.attr('viewBox', `0 0 ${layout.w} ${layout.h}`).attr('height', layout.h)

    // Rebuild pipe shells once per layout (not every animation tick).
    const pipeSel = layers.pipes.selectAll<SVGGElement, Pipe>('g.pipe').data(layout.pipes, (d) => d.id)
    pipeSel.exit().remove()
    const pipeEnter = pipeSel.enter().append('g').attr('class', 'pipe')
    pipeEnter.each(function (d) {
      buildPipeShell(d3.select(this), d)
    })
    const pipeMerged = pipeEnter
      .merge(pipeSel)
      .attr('transform', (d) => `translate(${d.x},${d.y})`)
      .each(function (d) {
        updatePipeFill(d3.select(this), d, false)
      })
    if (pipeDragRef.current) pipeMerged.call(pipeDragRef.current)

    const flow = queueFlowEvents(tr)
    const adv = advanceFlowCursor(flow, lastIndexRef.current)
    lastIndexRef.current = adv.nextIndex
    if (adv.kind === 'delta' && adv.newest.length) {
      const bursts = d3.group(
        adv.newest.filter((ev) => ev.ok && ev.threadId != null),
        (ev) => flowEdgeId({ threadId: ev.threadId!, queueId: ev.queueId, op: ev.op }),
      )
      for (const events of bursts.values()) {
        fireBurst(events, layout, layers.packets, edgeStateRef.current)
      }
    } else if (adv.kind === 'first') {
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
    // adv.kind === 'trimmed': cursor rewound with the ring; wait for new appends.

    paintFrame(layers, layout, edgeStateRef.current, threadDragRef.current)

    const interval = window.setInterval(() => {
      if (layoutRef.current) paintFrame(layers, layoutRef.current, edgeStateRef.current, threadDragRef.current)
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

  const p = edgePath(thread, pipe, link, layout.pipes)
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

function paintFrame(
  layers: Layers,
  layout: Layout,
  edgeState: Map<string, EdgeState>,
  threadDrag?: d3.DragBehavior<SVGGElement, ThreadNode, ThreadNode | d3.SubjectPosition> | null,
) {
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
    // butt + straight end stubs keep the stroke flush with marker-end triangles.
    .attr('stroke-linecap', 'butt')
    .attr('stroke-linejoin', 'round')
    .merge(link)
    // Direction must remain legible even between the short-lived event pulses.
    .attr('marker-end', (d) => markerFor(d.link.op))
    .attr('stroke', (d) => strokeFor(d.link.op))
    .attr('stroke-width', (d) => (d.key.startsWith('struct:') ? 1.35 : d.hot ? 2.3 : 1.7))
    .attr('opacity', (d) => (d.key.startsWith('struct:') ? 0.52 : d.hot ? 0.96 : 0.68))
    .attr('d', (d) => edgePath(d.thread, d.pipe, d.link, layout.pipes).d)

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
    .attr('x', (entry) => burstBadgePosition(entry.thread, entry.pipe, entry.link, layout.pipes).x)
    .attr('y', (entry) => burstBadgePosition(entry.thread, entry.pipe, entry.link, layout.pipes).y)
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
  if (threadDrag) pillMerged.call(threadDrag)
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
 * Top/bottom rails share the ellipse ±ry so strokes meet without a gap or
 * double-line. Live depth updates go through updatePipeFill.
 */
function buildPipeShell(g: d3.Selection<SVGGElement, unknown, null, undefined>, pipe: Pipe): void {
  g.selectAll('*').remove()

  const x0 = -PIPE_W / 2
  const x1 = PIPE_W / 2
  const y0 = -MOUTH_RY
  const y1 = MOUTH_RY
  const stroke = 'rgba(203,213,225,0.72)'
  const strokeW = 1

  // Barrel body — fill only. Vertical ends are the mouth ellipses; stroking a
  // rect here leaves a 1px seam where the caps meet the rails.
  g.append('rect')
    .attr('class', 'barrel-fill')
    .attr('x', x0)
    .attr('y', y0)
    .attr('width', PIPE_W)
    .attr('height', PIPE_H)
    .attr('fill', '#151f30')

  // Inner channel (occupancy track).
  const boreX = x0 + MOUTH_RX + 4
  const boreY = y0 + 9
  const boreW = PIPE_W - MOUTH_RX * 2 - 8
  const boreH = PIPE_H - 18
  g.append('rect')
    .attr('class', 'bore')
    .attr('x', boreX)
    .attr('y', boreY)
    .attr('width', boreW)
    .attr('height', boreH)
    .attr('rx', boreH / 2)
    .attr('fill', '#0b1220')

  g.append('rect')
    .attr('class', 'fill')
    .attr('x', boreX + 2)
    .attr('y', boreY + 2)
    .attr('height', boreH - 4)
    .attr('rx', (boreH - 4) / 2)
    .attr('width', 0)
    .attr('fill', '#38bdf8')
    .attr('fill-opacity', 0.56)

  // Mouth caps first (under the rails) so the horizontal strokes sit on top at
  // the tangent points and read as one continuous silhouette.
  const drawMouth = (cx: number, cls: string) => {
    g.append('ellipse')
      .attr('class', 'mouth-ring')
      .attr('cx', cx)
      .attr('cy', 0)
      .attr('rx', MOUTH_RX)
      .attr('ry', MOUTH_RY)
      .attr('fill', '#151f30')
      .attr('stroke', stroke)
      .attr('stroke-width', strokeW)
    g.append('ellipse')
      .attr('class', cls)
      .attr('cx', cx)
      .attr('cy', 0)
      .attr('rx', Math.max(3, MOUTH_RX - 2.5))
      .attr('ry', Math.max(8, MOUTH_RY - 5))
      .attr('fill', '#0b1220')
      .attr('stroke', 'rgba(148,163,184,0.4)')
      .attr('stroke-width', 0.6)
  }
  drawMouth(x0, 'mouth-end')
  drawMouth(x1, 'mouth-front')

  // Top + bottom rails — exact tangents of both mouth ellipses.
  g.append('line')
    .attr('class', 'barrel-rail')
    .attr('x1', x0)
    .attr('y1', y0)
    .attr('x2', x1)
    .attr('y2', y0)
    .attr('stroke', stroke)
    .attr('stroke-width', strokeW)
    .attr('stroke-linecap', 'butt')
  g.append('line')
    .attr('class', 'barrel-rail')
    .attr('x1', x0)
    .attr('y1', y1)
    .attr('x2', x1)
    .attr('y2', y1)
    .attr('stroke', stroke)
    .attr('stroke-width', strokeW)
    .attr('stroke-linecap', 'butt')

  g.append('text')
    .attr('x', x0)
    .attr('y', y1 + 12)
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(148,163,184,0.7)')
    .attr('font-size', 8)
    .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
    .text('end')
  g.append('text')
    .attr('x', x1)
    .attr('y', y1 + 12)
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
  const boreX = -PIPE_W / 2 + MOUTH_RX + 4
  const boreW = PIPE_W - MOUTH_RX * 2 - 8
  const fillFrac = pipe.cap > 0 ? Math.min(1, pipe.depth / pipe.cap) : 0
  const fillW = Math.max(0, (boreW - 4) * fillFrac)
  const stroke = hot ? '#e2e8f0' : 'rgba(203,213,225,0.72)'
  const strokeW = hot ? 1.25 : 1

  g.selectAll('line.barrel-rail').attr('stroke', stroke).attr('stroke-width', strokeW)
  g.selectAll('ellipse.mouth-ring').attr('stroke', stroke).attr('stroke-width', strokeW)

  g.select('rect.fill')
    .attr('x', boreX + 2)
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
