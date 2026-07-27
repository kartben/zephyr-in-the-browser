/**
 * Arbitration lane strip for {@link ./CanPanel}.
 *
 * One lane per node, time to the right. Each tick is a frame that crossed (or
 * tried to). A hollow tick is a lost-arbitration deferral; a dotted drop links
 * it to the winner that took the slot, and a hop points to the retry that
 * eventually went out. No bit timing is modelled or implied — the view is
 * "who transmitted, who deferred", which is exactly what the page-side bus
 * knows. Same latitude `ws2812.ts` takes ignoring pulse timing.
 *
 * Kept out of `ctf/` on purpose: TracePanel's Gantt is bound to CTF's
 * thread/state model. This is a second, smaller renderer for a different
 * subject, not a reuse of that one.
 */

import type { CanLogEntry, CanNodeSnapshot } from '@/can/bus'

/** Sliding window the strip shows, in ms. */
export const LANE_WINDOW_MS = 2000

const PAD_L = 52
const PAD_R = 8
const PAD_T = 8
const PAD_B = 16
const TICK_H = 11
const LANE_MIN_H = 24

/** Stable palette; local node always takes the primary slot. */
const LANE_COLORS = [
  'oklch(0.62 0.19 292)',
  'oklch(0.7 0.16 152)',
  'oklch(0.77 0.15 78)',
  'oklch(0.75 0.13 235)',
  'oklch(0.7 0.14 25)',
  'oklch(0.72 0.12 200)',
]

export interface LaneTick {
  nodeId: string
  at: number
  /** Hollow outline: lost this slot. */
  lost: boolean
  frameId: number
  /** Winner frame id when `lost`. */
  lostTo?: number
  /** Seq of this log entry — used to pair a loss with its retry. */
  seq: number
}

export interface LaneHop {
  /** Node that deferred. */
  nodeId: string
  lostAt: number
  retryAt: number
  /** Node / frame id that won the contested slot. */
  winnerNodeId: string
  winnerAt: number
}

export interface LaneModel {
  lanes: { id: string; name: string; color: string; idLabel: string }[]
  ticks: LaneTick[]
  hops: LaneHop[]
  t0: number
  t1: number
}

/**
 * Build the lane model from the live roster and traffic log. Pure so tests can
 * assert the collision geometry without a canvas.
 */
export function buildLaneModel(
  nodes: readonly CanNodeSnapshot[],
  log: readonly CanLogEntry[],
  now: number,
  windowMs = LANE_WINDOW_MS,
): LaneModel {
  const t1 = now
  const t0 = t1 - windowMs
  const inWindow = log.filter((e) => e.at >= t0 && e.at <= t1)

  // Local first, then attachment order — matches the roster.
  const ordered = [...nodes].sort((a, b) => Number(b.local) - Number(a.local))
  const lanes = ordered.map((n, i) => ({
    id: n.id,
    name: n.name,
    color: LANE_COLORS[i % LANE_COLORS.length]!,
    idLabel: primaryIdLabel(n, inWindow),
  }))

  const ticks: LaneTick[] = []
  for (const e of inWindow) {
    if (e.kind === 'arbitration') {
      ticks.push({
        nodeId: e.from,
        at: e.at,
        lost: true,
        frameId: e.frame.id,
        lostTo: e.lostTo,
        seq: e.seq,
      })
      continue
    }
    // Frames and no-acks both occupied (or tried to occupy) the medium.
    ticks.push({
      nodeId: e.from,
      at: e.at,
      lost: false,
      frameId: e.frame.id,
      seq: e.seq,
    })
  }

  const hops: LaneHop[] = []
  for (const loss of inWindow) {
    if (loss.kind !== 'arbitration') continue
    const winner = inWindow.find(
      (e) =>
        e.kind !== 'arbitration' &&
        e.at === loss.at &&
        e.frame.id === loss.lostTo,
    )
    // Next successful (or attempted) send of the same id from the loser.
    const retry = inWindow.find(
      (e) =>
        e.kind !== 'arbitration' &&
        e.from === loss.from &&
        e.frame.id === loss.frame.id &&
        e.seq > loss.seq,
    )
    if (!winner || !retry) continue
    hops.push({
      nodeId: loss.from,
      lostAt: loss.at,
      retryAt: retry.at,
      winnerNodeId: winner.from,
      winnerAt: winner.at,
    })
  }

  return { lanes, ticks, hops, t0, t1 }
}

function primaryIdLabel(node: CanNodeSnapshot, log: readonly CanLogEntry[]): string {
  // Prefer the node's advertised transmit id from its summary ("0x0A0 every…"),
  // else the most recent frame id it put on the bus in the window.
  const m = node.summary.match(/0x([0-9A-Fa-f]+)/)
  if (m) return `0x${m[1]!.toUpperCase()}`
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    if (e.from === node.id && e.kind !== 'arbitration') {
      return `0x${hex(e.frame.id)}`
    }
  }
  return ''
}

function hex(id: number): string {
  return id.toString(16).toUpperCase().padStart(3, '0')
}

export function paintArbitrationLanes(
  canvas: HTMLCanvasElement,
  model: LaneModel,
  colors: { bg: string; muted: string; faint: string },
): void {
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const cssW = Math.max(1, canvas.clientWidth || 356)
  const laneCount = Math.max(1, model.lanes.length)
  const cssH = PAD_T + PAD_B + laneCount * LANE_MIN_H
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
  }
  canvas.style.height = `${cssH}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const plotW = cssW - PAD_L - PAD_R
  const laneH = (cssH - PAD_T - PAD_B) / laneCount
  const span = Math.max(1, model.t1 - model.t0)
  const xAt = (t: number) => PAD_L + ((t - model.t0) / span) * plotW
  const laneIndex = new Map(model.lanes.map((l, i) => [l.id, i]))
  const yOf = (nodeId: string) => {
    const i = laneIndex.get(nodeId) ?? 0
    return PAD_T + laneH * i + laneH / 2
  }

  ctx.clearRect(0, 0, cssW, cssH)
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, cssW, cssH)

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'middle'
  model.lanes.forEach((lane, i) => {
    const y = PAD_T + laneH * i + laneH / 2
    ctx.strokeStyle = colors.faint
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD_L, y)
    ctx.lineTo(cssW - PAD_R, y)
    ctx.stroke()
    ctx.fillStyle = colors.muted
    ctx.textAlign = 'left'
    const name = lane.name.length > 8 ? `${lane.name.slice(0, 7)}…` : lane.name
    ctx.fillText(name, 4, y - (lane.idLabel ? 6 : 0))
    if (lane.idLabel) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      ctx.fillText(lane.idLabel, 4, y + 6)
    }
  })

  for (const tick of model.ticks) {
    if (!laneIndex.has(tick.nodeId)) continue
    const lane = model.lanes[laneIndex.get(tick.nodeId)!]!
    const y = yOf(tick.nodeId)
    const x = xAt(tick.at)
    if (tick.lost) {
      ctx.strokeStyle = 'rgba(255,255,255,0.30)'
      ctx.lineWidth = 1
      ctx.strokeRect(x - 1.5, y - TICK_H / 2, 3, TICK_H)
    } else {
      ctx.fillStyle = lane.color
      ctx.fillRect(x - 1.5, y - TICK_H / 2, 3, TICK_H)
    }
  }

  for (const hop of model.hops) {
    if (!laneIndex.has(hop.nodeId) || !laneIndex.has(hop.winnerNodeId)) continue
    const yWin = yOf(hop.winnerNodeId)
    const yLose = yOf(hop.nodeId)
    const xLost = xAt(hop.lostAt)
    const xRetry = xAt(hop.retryAt)
    const loserLane = model.lanes[laneIndex.get(hop.nodeId)!]!

    // Drop from winner down (or up) to the hollow tick.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.setLineDash([2, 2])
    ctx.lineWidth = 1
    ctx.beginPath()
    const top = Math.min(yWin, yLose)
    const bot = Math.max(yWin, yLose)
    ctx.moveTo(xLost, top + TICK_H / 2)
    ctx.lineTo(xLost, bot - TICK_H / 2)
    ctx.stroke()
    ctx.setLineDash([])

    // Hop along the loser lane to its retry.
    if (xRetry - xLost > 4) {
      const hopColor = loserLane.color.startsWith('oklch')
        ? loserLane.color.replace(/\)$/, ' / 0.75)')
        : 'rgba(255,255,255,0.45)'
      ctx.strokeStyle = hopColor
      ctx.beginPath()
      ctx.moveTo(xLost + 2, yLose + TICK_H / 2 + 2)
      ctx.lineTo(xRetry - 2, yLose + TICK_H / 2 + 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(xRetry - 2, yLose + TICK_H / 2 + 2)
      ctx.lineTo(xRetry - 5, yLose + TICK_H / 2)
      ctx.lineTo(xRetry - 5, yLose + TICK_H / 2 + 4)
      ctx.closePath()
      ctx.fillStyle = hopColor
      ctx.fill()

      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.textAlign = 'center'
      ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText('lost → retry', (xLost + xRetry) / 2, yLose + TICK_H / 2 + 11)
    }
  }
}
