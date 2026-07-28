/**
 * Live Zephyr CTF Trace panel — Timeline Gantt + Message Queues + Networking.
 *
 * Timeline: thread lanes coloured by run / ready / blocked / sleep / suspended,
 * with a shared live-follow time window (pan / zoom / pinch / Shift-drag box
 * zoom). Optional msgq swim lanes line data-passing objects under the threads,
 * with dotted put/get connectors from the actor thread to each queue rail.
 * Lane groups (THREADS, MESSAGE QUEUES, …) carry small uppercase section
 * headers. Message Queues: per-msgq flow graph + depth from put/put_front/get
 * exits.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type PointerEventHandler,
  type ReactNode,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react'
import {
  Activity,
  BoxSelect,
  Crosshair,
  Maximize2,
  Waypoints,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { QueuesView, QUEUES_LABEL_W } from '@/components/QueuesView'
import { NetView, NET_LABEL_W } from '@/components/NetView'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  STATE_COLOR,
  STATE_LABEL,
  contextSwitchesIn,
  depthAt,
  fmtTime,
  isPutOp,
  msgqOpColor,
  queueAxisMax,
  queueChartOpLabel,
  queueFlowEvents,
  queueLabel,
  reconstructQueues,
  renderStateRows,
  sortQueuesByPipelineOrder,
  stateAt,
  threadLabel,
  threadPrio,
  threadRunningAt,
  visibleLanes,
  windowStats,
  type QueueFlowEvent,
  type QueueSeries,
  type ThreadState,
  type Trace,
} from '@/ctf'
import {
  clampPlotX,
  formatGuestTime,
  paintCanvasTimeAxis,
  paintPlayhead,
  plotWidth,
  tsAt,
  viewFromBoxSelection,
  wantsBoxZoom,
  windowTimeStep,
  xAt,
} from '@/components/traceChart'
import { getSnapshot, subscribe } from '@/hostTrace'
import * as debugUi from '@/lib/debugUi'
import * as hostGdb from '@/hostGdb'
import {
  STAGE_TRACE_KEY,
  effectiveExpandedIn,
  getState,
  setExpanded,
  setTab as setStoredTab,
  subscribe as subscribeDock,
  tabIn,
} from '@/lib/dockStore'

/** Room for thread name + optional prio / msgq depth in the left gutter. */
const LABEL_W = 128
const PAD = 8
/** Space reserved above the lanes for the time-axis ruler + labels. */
const AXIS_H = 28
/** Default live-follow window — last 200 ms of the stream. */
const DEFAULT_LIVE_WINDOW_NS = 200_000_000 // 200 ms
const MIN_WINDOW_NS = 1_000_000 // 1 ms
const ZOOM_IN = 0.7
const ZOOM_OUT = 1.4
const PAN_THRESHOLD_PX = 8
/** Pixel thinning for msgq marks / connectors on a single lane. */
const MSGQ_MARK_MIN_GAP_PX = 5
/** Small-caps group title row above each lane block (threads, msgq, …). */
const SECTION_HEADER_H = 15
/** Breath between consecutive Timeline groups. */
const SECTION_GAP = 4

type LaneSize = 's' | 'm' | 'l'

/** Known Timeline lane groups — extend as FIFO / LIFO / pipes land. */
type TimelineSectionId = 'threads' | 'msgq'

type TimelineSection = {
  id: TimelineSectionId
  /** Uppercase group label painted in the section header. */
  title: string
  headerTop: number
  lanesTop: number
  laneH: number
  rowCount: number
  bottom: number
}

const LANE_SIZES: Record<LaneSize, { thread: number; label: string }> = {
  s: { thread: 16, label: 'Compact' },
  m: { thread: 22, label: 'Default' },
  /** Noticeably roomier than Default — queue rails scale with it. */
  l: { thread: 40, label: 'Tall' },
}

/** Msgq swim lanes stay ~1.5× thread height at every size. */
function laneMetricsFor(size: LaneSize): LaneMetrics {
  const laneH = LANE_SIZES[size].thread
  return { laneH, msgqLaneH: Math.round(laneH * 1.5) }
}

type TraceTab = 'schedule' | 'queues' | 'net'

type MsgqSwimLane = { id: number; label: string; series: QueueSeries }

type LaneMetrics = { laneH: number; msgqLaneH: number }

type TimelineGeom = {
  lanes: number[]
  hasIsr: boolean
  /** All painted groups in top→bottom order (headers + lanes). */
  sections: TimelineSection[]
  lanesTop: number
  threadBlockRows: number
  threadsBottom: number
  showQueues: boolean
  queueHeaderTop: number
  queueTop: number
  queueBlockH: number
  /** Bottom of the last section (playhead / canvas height). */
  contentBottom: number
  laneH: number
  msgqLaneH: number
}

/** Ellipsize `text` so it fits in `maxW` with the current canvas font. */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return ''
  if (ctx.measureText(text).width <= maxW) return text
  if (ctx.measureText('…').width > maxW) return ''
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '…'
}

function msgqNameMap(): Map<number, string> {
  const map = new Map<number, string>()
  for (const o of hostGdb.getWaitObjects()) {
    if (o.kind === 'msgq' || o.name.toLowerCase().includes('msgq') || o.name.startsWith('q_')) {
      map.set(o.addr, o.name)
    }
  }
  for (const o of hostGdb.getWaitObjects()) {
    if (!map.has(o.addr)) map.set(o.addr, o.name)
  }
  return map
}

/** Stable msgq swim lanes for Timeline overlay — pipeline order, named when known. */
function msgqSwimLanes(tr: Trace, flow: QueueFlowEvent[]): MsgqSwimLane[] {
  const seen = new Set(flow.map((ev) => ev.queueId))
  if (seen.size === 0) return []
  return sortQueuesByPipelineOrder(
    tr,
    reconstructQueues(tr, msgqNameMap()).filter((q) => seen.has(q.id)),
  ).map((q) => ({ id: q.id, label: queueLabel(q), series: q }))
}

function timelineGeom(
  tr: Trace,
  showMsgq: boolean,
  queueCount: number,
  metrics: LaneMetrics,
): TimelineGeom {
  const lanes = visibleLanes(tr)
  const hasIsr = tr.isrSpans.length > 0
  const showQueues = showMsgq && queueCount > 0
  const threadBlockRows = lanes.length + (hasIsr ? 1 : 0)

  const threadsHeaderTop = AXIS_H
  const lanesTop = threadsHeaderTop + SECTION_HEADER_H
  const threadsBottom = lanesTop + threadBlockRows * metrics.laneH
  const threads: TimelineSection = {
    id: 'threads',
    title: 'THREADS',
    headerTop: threadsHeaderTop,
    lanesTop,
    laneH: metrics.laneH,
    rowCount: threadBlockRows,
    bottom: threadsBottom,
  }

  const sections: TimelineSection[] = [threads]
  let queueHeaderTop = threadsBottom
  let queueTop = threadsBottom
  let queueBlockH = 0
  let contentBottom = threadsBottom

  if (showQueues) {
    queueHeaderTop = threadsBottom + SECTION_GAP
    queueTop = queueHeaderTop + SECTION_HEADER_H
    const queuesBottom = queueTop + queueCount * metrics.msgqLaneH
    queueBlockH = queuesBottom - threadsBottom
    contentBottom = queuesBottom
    sections.push({
      id: 'msgq',
      title: 'MESSAGE QUEUES',
      headerTop: queueHeaderTop,
      lanesTop: queueTop,
      laneH: metrics.msgqLaneH,
      rowCount: queueCount,
      bottom: queuesBottom,
    })
  }

  return {
    lanes,
    hasIsr,
    sections,
    lanesTop,
    threadBlockRows,
    threadsBottom,
    showQueues,
    queueHeaderTop,
    queueTop,
    queueBlockH,
    contentBottom,
    laneH: metrics.laneH,
    msgqLaneH: metrics.msgqLaneH,
  }
}

/** Small uppercase group title above a lane block. */
function paintSectionHeader(
  ctx: CanvasRenderingContext2D,
  title: string,
  y: number,
  cssW: number,
) {
  ctx.fillStyle = 'rgba(15, 23, 42, 0.65)'
  ctx.fillRect(0, y, cssW - PAD, SECTION_HEADER_H)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(4, y + SECTION_HEADER_H - 0.5)
  ctx.lineTo(cssW - PAD, y + SECTION_HEADER_H - 0.5)
  ctx.stroke()
  ctx.fillStyle = 'rgba(148, 163, 184, 0.72)'
  ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, 4, y + SECTION_HEADER_H / 2)
}

function depthLabel(series: QueueSeries, ts: number): string {
  const d = depthAt(series.samples, ts)
  return series.cap != null && series.cap > 0 ? `${d}/${series.cap}` : String(d)
}

/** Vertical chevron — tip sits at `(x, y)` on the destination transition. */
function paintVArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: 'up' | 'down',
  color: string,
  scale = 1,
  kind: 'idle' | 'hot' | 'selected' = 'idle',
) {
  const s = (kind === 'idle' ? 4.25 : 5) * scale
  const path = () => {
    ctx.beginPath()
    if (dir === 'down') {
      ctx.moveTo(x, y)
      ctx.lineTo(x - s * 0.75, y - s)
      ctx.lineTo(x + s * 0.75, y - s)
    } else {
      ctx.moveTo(x, y)
      ctx.lineTo(x - s * 0.75, y + s)
      ctx.lineTo(x + s * 0.75, y + s)
    }
    ctx.closePath()
  }
  // Quiet hairline halo by default; stronger only when focused.
  path()
  ctx.fillStyle =
    kind === 'selected'
      ? 'rgba(248, 250, 252, 0.65)'
      : kind === 'hot'
        ? 'rgba(248, 250, 252, 0.5)'
        : 'rgba(248, 250, 252, 0.28)'
  ctx.fill()
  path()
  ctx.fillStyle = color
  ctx.fill()
}

/**
 * Hairline dashed msgq connector with a soft white underglow.
 * Idle stays thin; hot/selected pick up a bit more glow, not fat cores.
 * `zw` scales weight with zoom (1 ≈ default 200 ms live window).
 */
function strokeMsgqConnector(
  ctx: CanvasRenderingContext2D,
  x: number,
  y0: number,
  y1: number,
  color: string,
  kind: 'idle' | 'hot' | 'selected',
  zw = 1,
) {
  const dash =
    kind === 'idle'
      ? ([2 * zw, 2.5 * zw] as [number, number])
      : ([3 * zw, 1.5 * zw] as [number, number])
  const core = (kind === 'selected' ? 1.35 : kind === 'hot' ? 1.15 : 0.85) * zw
  const glow = (kind === 'selected' ? 2.75 : kind === 'hot' ? 2.25 : 1.55) * zw
  const glowA = kind === 'selected' ? 0.5 : kind === 'hot' ? 0.38 : 0.22

  ctx.setLineDash(dash)
  ctx.strokeStyle = `rgba(248, 250, 252, ${glowA})`
  ctx.lineWidth = glow
  ctx.beginPath()
  ctx.moveTo(x, y0)
  ctx.lineTo(x, y1)
  ctx.stroke()

  ctx.strokeStyle = color
  ctx.lineWidth = core
  ctx.beginPath()
  ctx.moveTo(x, y0)
  ctx.lineTo(x, y1)
  ctx.stroke()
  ctx.setLineDash([])
}

/** Origin mark with a soft white halo. */
function paintMsgqMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  kind: 'idle' | 'hot' | 'selected',
) {
  const halo = kind === 'idle' ? r + 0.7 : r + 1.2
  ctx.beginPath()
  ctx.arc(x, y, halo, 0, Math.PI * 2)
  ctx.fillStyle =
    kind === 'selected'
      ? 'rgba(248, 250, 252, 0.65)'
      : kind === 'hot'
        ? 'rgba(248, 250, 252, 0.5)'
        : 'rgba(248, 250, 252, 0.28)'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

/**
 * Mild stroke scale from the time window: zoomed in → a bit thicker,
 * zoomed out → a bit thinner. Anchored at the default 200 ms live window.
 */
function msgqZoomWeight(spanNs: number): number {
  const raw = Math.sqrt(DEFAULT_LIVE_WINDOW_NS / Math.max(MIN_WINDOW_NS, spanNs))
  return Math.min(1.45, Math.max(0.7, raw))
}

/** Pixel hit slop for clicking a msgq edge connector. */
const MSGQ_EDGE_HIT_PX = 7

type MsgqHover = {
  /** Flow event under the tip, if any. */
  eventIndex: number | null
  /** Queue swim lane under the pointer / involved by the event. */
  queueId: number | null
  /** Pointer is over a msgq swim lane (tip should stay queue-centric). */
  overQueueLane: boolean
}

function resolveMsgqHover(
  playhead: { ts: number; y: number } | null,
  tr: Trace,
  view0: number,
  view1: number,
  showMsgq: boolean,
  queueLanes: MsgqSwimLane[],
  msgqEvents: QueueFlowEvent[],
  metrics: LaneMetrics,
  /** Max |Δt| in raw CTF ns for snapping to a flow event. */
  maxDeltaNs: number,
): MsgqHover | null {
  if (!playhead || !showMsgq) return null
  const geom = timelineGeom(tr, showMsgq, queueLanes.length, metrics)
  const overQueue =
    geom.showQueues &&
    playhead.y >= geom.queueTop &&
    playhead.y < geom.queueTop + queueLanes.length * geom.msgqLaneH
      ? Math.floor((playhead.y - geom.queueTop) / geom.msgqLaneH)
      : -1

  if (overQueue >= 0 && overQueue < queueLanes.length) {
    const q = queueLanes[overQueue]!
    const msgq = nearestMsgqNear(
      msgqEvents.filter((ev) => ev.queueId === q.id),
      playhead.ts,
      view0,
      view1,
      maxDeltaNs,
    )
    return { queueId: q.id, eventIndex: msgq?.index ?? null, overQueueLane: true }
  }

  const msgq = nearestMsgqNear(msgqEvents, playhead.ts, view0, view1, maxDeltaNs)
  if (!msgq) return null
  return { queueId: msgq.queueId, eventIndex: msgq.index, overQueueLane: false }
}

const TRACE_TABS = ['schedule', 'queues', 'net'] as const satisfies readonly TraceTab[]

function clampView(tr: Trace, t0: number, t1: number): { t0: number; t1: number } {
  const span = Math.max(MIN_WINDOW_NS, t1 - t0)
  const total = Math.max(MIN_WINDOW_NS, tr.t1 - tr.t0)
  const win = Math.min(span, total)
  let a = t0
  let b = t0 + win
  if (a < tr.t0) {
    a = tr.t0
    b = a + win
  }
  if (b > tr.t1) {
    b = tr.t1
    a = Math.max(tr.t0, b - win)
  }
  return { t0: a, t1: Math.max(a + MIN_WINDOW_NS, b) }
}

function clampWindowNs(tr: Trace, ns: number): number {
  const total = Math.max(MIN_WINDOW_NS, tr.t1 - tr.t0)
  return Math.max(MIN_WINDOW_NS, Math.min(total, ns))
}

/** Follow view: window of `windowNs` ending at the newest timestamp. */
function livePinnedView(tr: Trace, windowNs: number): { t0: number; t1: number } {
  const win = clampWindowNs(tr, windowNs)
  const t1 = tr.t1
  return { t0: Math.max(tr.t0, t1 - win), t1 }
}

function zoomAround(
  tr: Trace,
  view: { t0: number; t1: number },
  factor: number,
  pivot: number,
): { t0: number; t1: number } {
  const span = view.t1 - view.t0
  const next = clampWindowNs(tr, span * factor)
  const frac = span > 0 ? (pivot - view.t0) / span : 0.5
  const t0 = pivot - next * frac
  return clampView(tr, t0, t0 + next)
}

function paint(
  canvas: HTMLCanvasElement,
  tr: Trace,
  view0: number,
  view1: number,
  follow: boolean,
  selectedLane: number | null,
  playheadTs: number | null,
  showMsgq: boolean,
  msgqEvents: QueueFlowEvent[],
  queueLanes: MsgqSwimLane[],
  metrics: LaneMetrics,
  hover: MsgqHover | null,
  /** When set, playhead snaps to this raw CTF ns (tip event). */
  snapTs: number | null,
  /** Sticky click-selected msgq edge (event index). */
  selectedEdge: number | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const geom = timelineGeom(tr, showMsgq, queueLanes.length, metrics)
  const { lanes, hasIsr, lanesTop, laneH, msgqLaneH, showQueues, queueTop, contentBottom } = geom
  const cssH = Math.max(120, contentBottom + 8)
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const plotW = plotWidth(cssW, LABEL_W, PAD)
  const span = Math.max(1, view1 - view0)
  const cols = Math.max(64, Math.floor(plotW))
  const rows = renderStateRows(tr, lanes, view0, view1, cols)
  const colW = plotW / cols
  const layout = { labelW: LABEL_W, pad: PAD, view0, view1, t0: tr.t0 }
  const depthProbeTs = playheadTs ?? view1
  const hoverActive =
    selectedEdge != null ||
    (hover != null && (hover.eventIndex != null || hover.queueId != null))

  paintCanvasTimeAxis(ctx, {
    cssW,
    labelW: LABEL_W,
    pad: PAD,
    view0,
    view1,
    t0: tr.t0,
    follow,
  })

  for (const section of geom.sections) {
    paintSectionHeader(ctx, section.title, section.headerTop, cssW)
  }

  // --- Thread lanes ------------------------------------------------------
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(LABEL_W, lanesTop, plotW, lanes.length * laneH)

  lanes.forEach((tid, row) => {
    const y = lanesTop + row * laneH
    const label = threadLabel(tr, tid)
    const prio = threadPrio(tr, tid)
    const selected = selectedLane === tid
    ctx.fillStyle = selected ? 'rgba(248, 250, 252, 0.95)' : 'rgba(148, 163, 184, 0.95)'
    ctx.font = `${selected ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textBaseline = 'middle'
    let prioW = 0
    if (prio != null) {
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      prioW = ctx.measureText(String(prio)).width
      ctx.font = `${selected ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
    }
    const nameMaxW = LABEL_W - 4 - (prio != null ? prioW + 10 : 6)
    ctx.fillText(fitLabel(ctx, label, nameMaxW), 4, y + laneH / 2)
    if (prio != null) {
      const prioStr = String(prio)
      ctx.fillStyle = selected ? 'rgba(148, 163, 184, 0.95)' : 'rgba(100, 116, 139, 0.95)'
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(prioStr, LABEL_W - prioW - 6, y + laneH / 2)
    }
    if (selected) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.18)'
      ctx.fillRect(LABEL_W, y, plotW, laneH)
    }

    const cells = rows.get(tid) ?? []
    for (let c = 0; c < cells.length; c++) {
      const st = cells[c]
      if (!st || st === 'dead') continue
      ctx.fillStyle = STATE_COLOR[st]
      ctx.globalAlpha = st === 'run' ? 1 : 0.78
      ctx.fillRect(LABEL_W + c * colW, y + 3, Math.max(1.25, colW + 0.75), laneH - 6)
    }
    ctx.globalAlpha = 1
  })

  if (hasIsr) {
    const y = lanesTop + lanes.length * laneH
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText('[ISR]', 4, y + laneH / 2)
    for (const [s, e] of tr.isrSpans) {
      if (e <= view0 || s >= view1) continue
      const x0 = LABEL_W + ((Math.max(s, view0) - view0) / span) * plotW
      const x1 = LABEL_W + ((Math.min(e, view1) - view0) / span) * plotW
      ctx.fillStyle = 'rgba(168, 85, 247, 0.8)'
      ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0), laneH - 6)
    }
  }

  // --- Msgq swim lanes + dotted connectors -------------------------------
  if (showMsgq && msgqEvents.length > 0) {
    const threadRowOf = new Map(lanes.map((tid, row) => [tid, row]))
    const queueRowOf = new Map(queueLanes.map((q, row) => [q.id, row]))
    const zw = msgqZoomWeight(span)
    const MARK_R = 2 * (0.85 + 0.15 * zw)
    const ARROW_H = 4.5 * (0.85 + 0.15 * zw)

    if (showQueues) {
      ctx.fillStyle = 'rgba(8, 47, 73, 0.35)'
      ctx.fillRect(LABEL_W, queueTop, plotW, queueLanes.length * msgqLaneH)

      queueLanes.forEach((q, row) => {
        const y = queueTop + row * msgqLaneH
        const laneHot = hover?.queueId === q.id
        if (laneHot) {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.16)'
          ctx.fillRect(0, y, cssW - PAD, msgqLaneH)
          ctx.fillStyle = 'rgba(56, 189, 248, 0.22)'
          ctx.fillRect(LABEL_W, y, plotW, msgqLaneH)
        }

        const yMax = queueAxisMax(q.series)
        const innerPad = 3
        const innerH = Math.max(2, msgqLaneH - innerPad * 2)

        for (let c = 0; c < cols; c++) {
          const ts = view0 + ((c + 0.5) / cols) * span
          const d = depthAt(q.series.samples, ts)
          if (d <= 0) continue
          const h = Math.max(1.5, (d / yMax) * innerH)
          ctx.fillStyle = laneHot ? 'rgba(56, 189, 248, 0.45)' : 'rgba(56, 189, 248, 0.28)'
          ctx.fillRect(LABEL_W + c * colW, y + msgqLaneH - innerPad - h, Math.max(1, colW + 0.5), h)
        }

        ctx.fillStyle = laneHot ? 'rgba(186, 230, 253, 1)' : 'rgba(125, 211, 252, 0.9)'
        ctx.font = `${laneHot ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
        ctx.textBaseline = 'middle'
        const depthStr = depthLabel(q.series, depthProbeTs)
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        const depthW = ctx.measureText(depthStr).width
        ctx.font = `${laneHot ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
        const nameMaxW = LABEL_W - 4 - depthW - 10
        ctx.fillText(fitLabel(ctx, q.label, nameMaxW), 4, y + msgqLaneH / 2)
        ctx.fillStyle = laneHot ? 'rgba(186, 230, 253, 0.95)' : 'rgba(125, 211, 252, 0.7)'
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.fillText(depthStr, LABEL_W - depthW - 6, y + msgqLaneH / 2)

        ctx.strokeStyle = laneHot ? 'rgba(125, 211, 252, 0.55)' : 'rgba(56, 189, 248, 0.22)'
        ctx.lineWidth = laneHot ? 1.25 : 1
        ctx.beginPath()
        ctx.moveTo(LABEL_W, y + msgqLaneH / 2)
        ctx.lineTo(LABEL_W + plotW, y + msgqLaneH / 2)
        ctx.stroke()
      })
    }

    const lastXByKey = new Map<string, number>()
    const visible: QueueFlowEvent[] = []
    for (const ev of msgqEvents) {
      if (ev.ts < view0 || ev.ts > view1 || ev.threadId == null) continue
      if (!threadRowOf.has(ev.threadId)) continue
      const thinKey = `${ev.threadId}|${ev.queueId}`
      const x = LABEL_W + ((ev.ts - view0) / span) * plotW
      const prev = lastXByKey.get(thinKey)
      if (prev != null && x - prev < MSGQ_MARK_MIN_GAP_PX) continue
      lastXByKey.set(thinKey, x)
      visible.push(ev)
    }
    // Draw dim connectors first; hovered / sticky-selected last (on top).
    const focusIndex = hover?.eventIndex ?? selectedEdge
    const ordered =
      focusIndex != null
        ? [
            ...visible.filter((ev) => ev.index !== focusIndex),
            ...visible.filter((ev) => ev.index === focusIndex),
          ]
        : visible

    for (const ev of ordered) {
      const tRow = threadRowOf.get(ev.threadId!)!
      const x = LABEL_W + ((ev.ts - view0) / span) * plotW
      const threadY = lanesTop + tRow * laneH + laneH / 2
      const color = msgqOpColor(ev.op, ev.ok)
      const qRow = queueRowOf.get(ev.queueId)
      const queueY =
        qRow != null && showQueues ? queueTop + qRow * msgqLaneH + msgqLaneH / 2 : null
      const selected = selectedEdge === ev.index
      const hovered =
        hover?.eventIndex === ev.index ||
        (hover?.eventIndex == null && hover?.queueId === ev.queueId && !selectedEdge)
      const hot = selected || hovered
      const dim = hoverActive && !hot
      const put = isPutOp(ev.op)
      const kind = selected ? 'selected' : hot ? 'hot' : 'idle'
      const scale = selected ? 1.25 : hot ? 1.15 : 1
      const markR = MARK_R * scale
      const arrowH = ARROW_H * scale

      ctx.globalAlpha = dim ? 0.1 : hot ? 1 : 0.42

      if (queueY != null && Math.abs(queueY - threadY) > markR * 2 + arrowH) {
        // put: thread ○ →↓ queue    get: queue ○ →↑ thread
        // Timestamps are raw CTF ns; x is a pure linear map of those ns.
        const startY = put ? threadY : queueY
        const tipY = put ? queueY : threadY
        const dir: 'up' | 'down' = tipY > startY ? 'down' : 'up'
        const edgeStart = dir === 'down' ? startY + markR : startY - markR
        const edgeBeforeTip = dir === 'down' ? tipY - arrowH : tipY + arrowH

        strokeMsgqConnector(ctx, x, edgeStart, edgeBeforeTip, color, kind, zw)
        paintMsgqMark(ctx, x, startY, markR, color, kind)
        paintVArrow(ctx, x, tipY, dir, color, scale, kind)
      } else {
        strokeMsgqConnector(
          ctx,
          x,
          threadY - laneH / 2 + 2,
          threadY + laneH / 2 - 2,
          color,
          kind,
          zw,
        )
        paintMsgqMark(ctx, x, threadY, markR, color, kind)
      }

      ctx.globalAlpha = 1
    }
  }

  // Playhead uses the same ns→x map; when a tip event is active, snap to that
  // event’s raw timestamp so the line sits on the connector.
  const headTs = snapTs ?? playheadTs
  if (headTs != null) {
    const x = xAt(layout, cssW, headTs)
    if (x >= LABEL_W && x <= LABEL_W + plotW) {
      paintPlayhead(ctx, {
        x,
        y0: AXIS_H,
        y1: contentBottom,
      })
    }
  }

  canvas.style.height = `${cssH}px`
}

/** Nearest msgq flow event near `ts` within `maxDeltaNs` (raw CTF ns). */
function nearestMsgqNear(
  events: QueueFlowEvent[],
  ts: number,
  view0: number,
  view1: number,
  maxDeltaNs: number,
): QueueFlowEvent | null {
  let best: QueueFlowEvent | null = null
  let bestDist = Infinity
  for (const ev of events) {
    if (ev.ts < view0 || ev.ts > view1) continue
    const d = Math.abs(ev.ts - ts)
    if (d < bestDist) {
      bestDist = d
      best = ev
    }
  }
  if (!best || bestDist > maxDeltaNs) return null
  return best
}

/**
 * Hit-test a vertical msgq connector at canvas (x, y).
 * Returns the event index of the nearest edge within {@link MSGQ_EDGE_HIT_PX}, or null.
 */
function hitTestMsgqEdge(
  tr: Trace,
  view0: number,
  view1: number,
  cssW: number,
  x: number,
  y: number,
  showMsgq: boolean,
  msgqEvents: QueueFlowEvent[],
  queueLanes: MsgqSwimLane[],
  metrics: LaneMetrics,
): number | null {
  if (!showMsgq || queueLanes.length === 0) return null
  const geom = timelineGeom(tr, showMsgq, queueLanes.length, metrics)
  if (!geom.showQueues) return null
  const plotW = plotWidth(cssW, LABEL_W, PAD)
  const span = Math.max(1, view1 - view0)
  const threadRowOf = new Map(geom.lanes.map((tid, row) => [tid, row]))
  const queueRowOf = new Map(queueLanes.map((q, row) => [q.id, row]))

  let best: number | null = null
  let bestDist = MSGQ_EDGE_HIT_PX
  const lastXByKey = new Map<string, number>()
  for (const ev of msgqEvents) {
    if (ev.ts < view0 || ev.ts > view1 || ev.threadId == null) continue
    const tRow = threadRowOf.get(ev.threadId)
    const qRow = queueRowOf.get(ev.queueId)
    if (tRow == null || qRow == null) continue
    const ex = LABEL_W + ((ev.ts - view0) / span) * plotW
    const thinKey = `${ev.threadId}|${ev.queueId}`
    const prev = lastXByKey.get(thinKey)
    if (prev != null && ex - prev < MSGQ_MARK_MIN_GAP_PX) continue
    lastXByKey.set(thinKey, ex)
    const threadY = geom.lanesTop + tRow * geom.laneH + geom.laneH / 2
    const queueY = geom.queueTop + qRow * geom.msgqLaneH + geom.msgqLaneH / 2
    const y0 = Math.min(threadY, queueY)
    const y1 = Math.max(threadY, queueY)
    if (y < y0 - MSGQ_EDGE_HIT_PX || y > y1 + MSGQ_EDGE_HIT_PX) continue
    const dx = Math.abs(x - ex)
    if (dx <= bestDist) {
      bestDist = dx
      best = ev.index
    }
  }
  return best
}

type TraceSurface = HTMLCanvasElement | SVGSVGElement

type Gesture =
  | {
      kind: 'pan'
      pointerId: number
      startX: number
      origin: { t0: number; t1: number }
      moved: boolean
    }
  | {
      kind: 'boxZoom'
      pointerId: number
      /** Local X within the surface (CSS px). */
      startX: number
      origin: { t0: number; t1: number }
      moved: boolean
    }
  | {
      kind: 'pinch'
      startDist: number
      startSpan: number
      pivot: number
      origin: { t0: number; t1: number }
    }

/** Rubber-band preview while Shift-drag / box-zoom mode is active. */
type BoxZoomPreview = { x0: number; x1: number; cssW: number }

function BoxZoomOverlay({
  preview,
  gutterW,
  label,
}: {
  preview: BoxZoomPreview
  gutterW: number
  label: string
}): ReactNode {
  const plotLeft = gutterW
  const plotRight = Math.max(plotLeft + 1, preview.cssW - PAD)
  const a = clampPlotX(preview.x0, preview.cssW, gutterW, PAD)
  const b = clampPlotX(preview.x1, preview.cssW, gutterW, PAD)
  const left = Math.min(a, b)
  const right = Math.max(a, b)
  const width = Math.max(1, right - left)
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden rounded">
      <div
        className="absolute inset-y-0 bg-slate-950/50"
        style={{ left: plotLeft, width: Math.max(0, left - plotLeft) }}
      />
      <div
        className="absolute inset-y-0 border-x-2 border-sky-400/85 bg-sky-400/20"
        style={{ left, width }}
      >
        <div className="absolute left-1/2 top-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-sky-400 px-1.5 py-0.5 font-mono text-[9px] font-medium leading-none text-slate-950 shadow-sm">
          {label}
        </div>
      </div>
      <div
        className="absolute inset-y-0 bg-slate-950/50"
        style={{ left: right, width: Math.max(0, plotRight - right) }}
      />
    </div>
  )
}

export function TracePanel({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const [follow, setFollow] = useState(true)
  /** Lets the header Crosshair jump-to-live without keeping view state in the shell. */
  const bodyApiRef = useRef<{ jumpLive: () => void } | null>(null)

  useEffect(() => {
    if (defaultExpanded) setExpanded(STAGE_TRACE_KEY, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded])

  if ((!snap.available && !defaultExpanded) || dock.devices[STAGE_TRACE_KEY]?.hidden) {
    return null
  }

  const expanded = defaultExpanded || effectiveExpandedIn(dock, STAGE_TRACE_KEY, 'trace')

  const live = snap.eventCount > 0
  const statusLabel = live ? null : 'ctf'
  const statusDetail = live
    ? `${snap.eventCount} evt · ${snap.threadCount} thr`
    : 'waiting…'

  return (
    <PanelFrame
      id="trace"
      title="Trace"
      icon={Activity}
      defaultExpanded={expanded}
      dockedWidth={34}
      side="left"
      status={
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              live ? 'bg-amber-500/80' : 'bg-muted-foreground/50',
            )}
            aria-hidden
          />
          {statusLabel && <span className="shrink-0 text-foreground/70">{statusLabel}</span>}
          <span className="min-w-0 truncate text-muted-foreground">{statusDetail}</span>
        </span>
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={follow ? 'Following live edge' : 'Jump to live edge'}
          aria-label={follow ? 'Following live edge' : 'Jump to live edge'}
          aria-pressed={follow}
          onClick={() => {
            bodyApiRef.current?.jumpLive()
            setFollow(true)
          }}
          className={cn('size-8 touch-manipulation', follow && 'text-primary')}
        >
          <Crosshair className="size-4" />
        </Button>
      }
    >
      {!live ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">Waiting for traces…</p>
      ) : (
        <TracePanelBody snap={snap} follow={follow} setFollow={setFollow} apiRef={bodyApiRef} />
      )}
    </PanelFrame>
  )
}

function TracePanelBody({
  snap,
  follow,
  setFollow,
  apiRef,
}: {
  snap: ReturnType<typeof getSnapshot>
  follow: boolean
  setFollow: (v: boolean) => void
  apiRef: MutableRefObject<{ jumpLive: () => void } | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const queuesSvgRef = useRef<SVGSVGElement>(null)
  const netCanvasRef = useRef<HTMLCanvasElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const viewRef = useRef<{ t0: number; t1: number } | null>(null)
  /** Desired live-follow window; zoom while LIVE updates this instead of detaching. */
  const [liveWindowNs, setLiveWindowNs] = useState(DEFAULT_LIVE_WINDOW_NS)
  const [view, setView] = useState<{ t0: number; t1: number } | null>(null)
  const [selectedLane, setSelectedLane] = useState<number | null>(null)
  /** Line msgq put/get/put_front marks onto thread lanes. */
  const [showMsgq, setShowMsgq] = useState(true)
  const [laneSize, setLaneSize] = useState<LaneSize>('m')
  /** Sticky click-selected msgq edge (tr.events index). */
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  /** Timeline playhead — hover ts; null when not scrubbing. */
  const [playhead, setPlayhead] = useState<{ ts: number; x: number; y: number } | null>(null)
  /**
   * Sticky box-zoom mode: drag selects a time range (Shift temporarily pans).
   * When off, plain drag pans and Shift-drag box-zooms.
   */
  const [boxZoomMode, setBoxZoomMode] = useState(false)
  const [shiftHeld, setShiftHeld] = useState(false)
  const [boxZoomPreview, setBoxZoomPreview] = useState<BoxZoomPreview | null>(null)
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const showMsgqRef = useRef(showMsgq)
  showMsgqRef.current = showMsgq
  const boxZoomModeRef = useRef(boxZoomMode)
  boxZoomModeRef.current = boxZoomMode
  const laneMetrics = useMemo(() => laneMetricsFor(laneSize), [laneSize])
  const laneMetricsRef = useRef(laneMetrics)
  laneMetricsRef.current = laneMetrics
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const tab = tabIn(dock, STAGE_TRACE_KEY, TRACE_TABS, 'schedule') as TraceTab
  const setTab = (id: TraceTab) => setStoredTab(STAGE_TRACE_KEY, id)
  const followRef = useRef(follow)
  followRef.current = follow
  viewRef.current = view
  const gutterW = tab === 'queues' ? QUEUES_LABEL_W : tab === 'net' ? NET_LABEL_W : LABEL_W
  const boxZoomArmed = boxZoomMode || shiftHeld || boxZoomPreview != null

  const tr = snap.trace
  const msgqEvents = useMemo(
    () => (tr ? queueFlowEvents(tr) : []),
    // revision bumps whenever the event ring changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, snap.revision],
  )
  const queueLanes = useMemo(
    () => (tr ? msgqSwimLanes(tr, msgqEvents) : []),
    // names can appear once GDB wait-objects resolve; revision covers CTF growth
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, msgqEvents, snap.revision],
  )
  const msgqEventsRef = useRef(msgqEvents)
  msgqEventsRef.current = msgqEvents
  const queueLanesRef = useRef(queueLanes)
  queueLanesRef.current = queueLanes

  const msgqHover = useMemo(() => {
    if (!tr || !view || !playhead) return null
    const cssW = canvasRef.current?.clientWidth ?? 480
    const plotW = plotWidth(cssW, LABEL_W, PAD)
    // ~8px in raw ns — keeps tip/snap tight to the mark under the cursor.
    const maxDeltaNs = Math.max(50_000, ((view.t1 - view.t0) * 8) / Math.max(1, plotW))
    return resolveMsgqHover(
      playhead,
      tr,
      view.t0,
      view.t1,
      showMsgq,
      queueLanes,
      msgqEvents,
      laneMetrics,
      maxDeltaNs,
    )
  }, [playhead, tr, view, showMsgq, queueLanes, msgqEvents, laneMetrics])
  const msgqHoverRef = useRef(msgqHover)
  msgqHoverRef.current = msgqHover
  const snapTs = useMemo(() => {
    const idx = msgqHover?.eventIndex ?? selectedEdge
    if (idx == null) return null
    return msgqEvents.find((ev) => ev.index === idx)?.ts ?? null
  }, [msgqHover, selectedEdge, msgqEvents])
  const snapTsRef = useRef(snapTs)
  snapTsRef.current = snapTs
  const selectedEdgeRef = useRef(selectedEdge)
  selectedEdgeRef.current = selectedEdge

  useEffect(() => {
    if (!showMsgq) setSelectedEdge(null)
  }, [showMsgq])

  useEffect(() => {
    if (!tr || tr.events.length === 0) return
    if (follow) {
      setView(livePinnedView(tr, liveWindowNs))
    }
  }, [tr, follow, liveWindowNs, snap.revision])

  useEffect(() => {
    if (tab !== 'schedule') return
    const canvas = canvasRef.current
    if (!canvas || !tr || !view) return
    paint(
      canvas,
      tr,
      view.t0,
      view.t1,
      follow,
      selectedLane,
      playhead?.ts ?? null,
      showMsgq,
      msgqEvents,
      queueLanes,
      laneMetrics,
      msgqHover,
      snapTs,
      selectedEdge,
    )
  }, [
    tr,
    view,
    follow,
    snap.revision,
    selectedLane,
    tab,
    playhead,
    showMsgq,
    msgqEvents,
    queueLanes,
    laneMetrics,
    msgqHover,
    snapTs,
    selectedEdge,
  ])

  useEffect(() => {
    if (tab !== 'schedule') return
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!tr || !viewRef.current) return
      paint(
        canvas,
        tr,
        viewRef.current.t0,
        viewRef.current.t1,
        follow,
        selectedLane,
        playheadRef.current?.ts ?? null,
        showMsgqRef.current,
        msgqEventsRef.current,
        queueLanesRef.current,
        laneMetricsRef.current,
        msgqHoverRef.current,
        snapTsRef.current,
        selectedEdgeRef.current,
      )
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, follow, selectedLane, tab])

  useEffect(() => {
    if (tab !== 'schedule') {
      setPlayhead(null)
      setSelectedEdge(null)
    }
    setBoxZoomPreview(null)
    if (gestureRef.current?.kind === 'boxZoom') gestureRef.current = null
  }, [tab])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(true)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftHeld(false)
    }
    const clear = () => setShiftHeld(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useEffect(() => {
    if (!boxZoomPreview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      gestureRef.current = null
      setBoxZoomPreview(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [boxZoomPreview])

  const applyZoom = useCallback(
    (factor: number) => {
      if (!tr || !view) return
      if (follow) {
        const next = clampWindowNs(tr, (view.t1 - view.t0) * factor)
        setLiveWindowNs(next)
        setView(livePinnedView(tr, next))
        return
      }
      const pivot = (view.t0 + view.t1) / 2
      setView(zoomAround(tr, view, factor, pivot))
    },
    [tr, view, follow],
  )

  const fitAll = useCallback(() => {
    if (!tr || tr.events.length === 0) return
    setFollow(false)
    setView({ t0: tr.t0, t1: Math.max(tr.t0 + MIN_WINDOW_NS, tr.t1) })
  }, [tr, setFollow])

  const jumpLive = useCallback(() => {
    if (view) setLiveWindowNs(view.t1 - view.t0)
    setFollow(true)
  }, [view, setFollow])

  useEffect(() => {
    apiRef.current = { jumpLive }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, jumpLive])

  const panByFraction = useCallback(
    (frac: number) => {
      if (!tr || !view) return
      setFollow(false)
      const span = view.t1 - view.t0
      setView(clampView(tr, view.t0 + span * frac, view.t1 + span * frac))
    },
    [tr, view, setFollow],
  )

  const lanes = tr ? visibleLanes(tr) : []
  const lane = selectedLane ?? lanes[0] ?? null
  const lanePrio = tr && lane !== null ? threadPrio(tr, lane) : null
  // Info strip follows the playhead when scrubbing; otherwise the right edge
  // (live edge when following) — same role as the Python viewer's cursor.
  const probeTs = playhead?.ts ?? view?.t1 ?? tr?.t1 ?? 0
  const runningTid = tr ? threadRunningAt(tr, probeTs) : null
  const [st, reason] =
    tr && lane !== null ? stateAt(tr, lane, probeTs) : ([null, ''] as [ThreadState | null, string])
  const stats = tr && view ? windowStats(tr, view.t0, view.t1) : null
  const switches = tr && view ? contextSwitchesIn(tr, view.t0, view.t1) : 0
  let cpuBusy = 0
  if (tr && stats) {
    const idleIds = new Set(
      [...tr.threads.entries()].filter(([, info]) => info.name === 'idle').map(([id]) => id),
    )
    let runTotal = 0
    let idleRun = 0
    for (const [tid, acc] of stats.per) {
      runTotal += acc.run ?? 0
      if (idleIds.has(tid)) idleRun += acc.run ?? 0
    }
    cpuBusy = Math.max(0, Math.min(1, (runTotal - idleRun) / stats.spanNs))
  }
  const secs = stats ? stats.spanNs / 1e9 : 0

  const scheduleTip = (() => {
    if (!playhead || !tr || !view) return null

    const q =
      msgqHover?.queueId != null
        ? queueLanes.find((lane) => lane.id === msgqHover.queueId)
        : selectedEdge != null
          ? (() => {
              const ev = msgqEvents.find((e) => e.index === selectedEdge)
              return ev ? queueLanes.find((lane) => lane.id === ev.queueId) : undefined
            })()
          : undefined
    const msgq =
      msgqHover?.eventIndex != null
        ? (msgqEvents.find((ev) => ev.index === msgqHover.eventIndex) ?? null)
        : selectedEdge != null
          ? (msgqEvents.find((ev) => ev.index === selectedEdge) ?? null)
          : null
    // Tip / playhead snap to the event’s raw CTF ns when we have one.
    const tipTs = msgq?.ts ?? playhead.ts

    // Queue-lane tip: keep it about the queue / op — not who is running.
    if (msgqHover?.overQueueLane && q) {
      const lines: string[] = []
      if (msgq) {
        const who = msgq.threadId != null ? threadLabel(tr, msgq.threadId) : '?'
        const fail = msgq.ok ? '' : ' fail'
        const arrow = isPutOp(msgq.op) ? '→' : '←'
        lines.push(`${queueChartOpLabel(msgq.op)}${fail} · ${who} ${arrow} ${q.label}`)
      } else {
        lines.push(q.label)
      }
      lines.push(`depth ${depthLabel(q.series, tipTs)}`)
      const cssWQ = canvasRef.current?.clientWidth ?? 480
      const stepQ = windowTimeStep(view.t0, view.t1, plotWidth(cssWQ, LABEL_W, PAD))
      lines.push(formatGuestTime(tipTs, stepQ))
      return lines
    }

    const cssW = canvasRef.current?.clientWidth ?? 480
    const step = windowTimeStep(view.t0, view.t1, plotWidth(cssW, LABEL_W, PAD))
    const guest = formatGuestTime(tipTs, step)
    const runLabel = runningTid != null ? threadLabel(tr, runningTid) : '(idle)'
    // Absolute guest CTF ns from timing_ns_get (not relative to first event).
    const lines = [`${guest} · ${runLabel}`]

    // When the pointer is over a thread lane label, show that lane’s full name.
    if (playhead.x < LABEL_W) {
      const geom = timelineGeom(tr, showMsgq, queueLanes.length, laneMetrics)
      const row = Math.floor((playhead.y - geom.lanesTop) / geom.laneH)
      if (row >= 0 && row < geom.lanes.length) {
        const tid = geom.lanes[row]!
        const full = threadLabel(tr, tid)
        const prio = threadPrio(tr, tid)
        lines.push(prio != null ? `${full} · prio ${prio}` : full)
      }
    }

    if (msgq) {
      const who = msgq.threadId != null ? threadLabel(tr, msgq.threadId) : '?'
      const qName = q?.label ?? `0x${msgq.queueId.toString(16)}`
      const fail = msgq.ok ? '' : ' fail'
      const arrow = isPutOp(msgq.op) ? '→' : '←'
      const depth = q ? ` · depth ${depthLabel(q.series, msgq.ts)}` : ''
      lines.push(`${queueChartOpLabel(msgq.op)}${fail} · ${who} ${arrow} ${qName}${depth}`)
    }
    return lines
  })()

  const selectLane = (tid: number) => {
    setSelectedLane(tid)
    // CTF thread_id is the TCB address — open Debug → Threads and blink it.
    if (hostGdb.getSnapshot().available) {
      debugUi.focusDebugThread(tid, threadLabel(tr!, tid))
    }
  }

  const onWheel: WheelEventHandler<TraceSurface> = (e) => {
    if (!view || !tr) return
    e.preventDefault()
    const factor = e.deltaY > 0 ? ZOOM_OUT : ZOOM_IN
    if (follow) {
      const next = clampWindowNs(tr, (view.t1 - view.t0) * factor)
      setLiveWindowNs(next)
      setView(livePinnedView(tr, next))
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const plotW = Math.max(1, rect.width - gutterW - PAD)
    const x = e.clientX - rect.left
    const frac = x < gutterW ? 0.5 : Math.min(1, Math.max(0, (x - gutterW) / plotW))
    const pivot = view.t0 + frac * (view.t1 - view.t0)
    setView(zoomAround(tr, view, factor, pivot))
  }

  const onPointerDown: PointerEventHandler<TraceSurface> = (e) => {
    if (!view || !tr || !e.isPrimary) return
    // Keep pan/drag from selecting axis labels and nearby UI text.
    window.getSelection()?.removeAllRanges()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const localX = e.clientX - rect.left
    if (wantsBoxZoom(e.shiftKey, boxZoomModeRef.current)) {
      setPlayhead(null)
      setBoxZoomPreview({
        x0: localX,
        x1: localX,
        cssW: e.currentTarget.clientWidth,
      })
      gestureRef.current = {
        kind: 'boxZoom',
        pointerId: e.pointerId,
        startX: localX,
        origin: view,
        moved: false,
      }
      return
    }
    gestureRef.current = {
      kind: 'pan',
      pointerId: e.pointerId,
      startX: e.clientX,
      origin: view,
      moved: false,
    }
  }

  const onPointerMove: PointerEventHandler<TraceSurface> = (e) => {
    const g = gestureRef.current
    if (!g || g.kind === 'pinch' || g.pointerId !== e.pointerId || !tr) return
    if (g.kind === 'boxZoom') {
      const rect = e.currentTarget.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const dx = localX - g.startX
      if (!g.moved && Math.abs(dx) < PAN_THRESHOLD_PX) return
      g.moved = true
      window.getSelection()?.removeAllRanges()
      setPlayhead(null)
      setBoxZoomPreview({
        x0: g.startX,
        x1: localX,
        cssW: e.currentTarget.clientWidth,
      })
      return
    }
    const dx = e.clientX - g.startX
    if (!g.moved && Math.abs(dx) < PAN_THRESHOLD_PX) return
    g.moved = true
    window.getSelection()?.removeAllRanges()
    setFollow(false)
    setPlayhead(null)
    const plotW = Math.max(1, e.currentTarget.clientWidth - gutterW - PAD)
    const span = g.origin.t1 - g.origin.t0
    const dt = (-dx / plotW) * span
    setView(clampView(tr, g.origin.t0 + dt, g.origin.t1 + dt))
  }

  const onPointerUp: PointerEventHandler<TraceSurface> = (e) => {
    const g = gestureRef.current
    if (!g || g.kind === 'pinch' || g.pointerId !== e.pointerId) return
    gestureRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }

    if (g.kind === 'boxZoom') {
      setBoxZoomPreview(null)
      if (!g.moved || !tr) return
      const rect = e.currentTarget.getBoundingClientRect()
      const endX = e.clientX - rect.left
      const next = viewFromBoxSelection(
        g.origin,
        e.currentTarget.clientWidth,
        gutterW,
        PAD,
        g.startX,
        endX,
        PAN_THRESHOLD_PX,
      )
      if (!next) return
      setFollow(false)
      setPlayhead(null)
      setLiveWindowNs(clampWindowNs(tr, next.t1 - next.t0))
      setView(clampView(tr, next.t0, next.t1))
      return
    }

    if (g.moved || !view || !tr || tab !== 'schedule') return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // Tap a msgq edge to pin/unpin its highlight.
    if (showMsgq && x >= LABEL_W) {
      const hit = hitTestMsgqEdge(
        tr,
        view.t0,
        view.t1,
        e.currentTarget.clientWidth,
        x,
        y,
        showMsgq,
        msgqEvents,
        queueLanes,
        laneMetrics,
      )
      if (hit != null) {
        setSelectedEdge((prev) => (prev === hit ? null : hit))
        return
      }
      // Empty plot click clears a sticky edge.
      if (selectedEdge != null) setSelectedEdge(null)
    }
    // Tap on a lane label selects it and opens Debug → Threads.
    if (x < LABEL_W && y >= AXIS_H) {
      const geom = timelineGeom(tr, showMsgq, queueLanes.length, laneMetrics)
      const row = Math.floor((y - geom.lanesTop) / geom.laneH)
      if (row >= 0 && row < geom.lanes.length) selectLane(geom.lanes[row]!)
    }
  }

  const onPointerCancel = () => {
    gestureRef.current = null
    setBoxZoomPreview(null)
  }

  const onTouchStart: TouchEventHandler<TraceSurface> = (e) => {
    if (!view || !tr || e.touches.length !== 2) return
    const a = e.touches[0]!
    const b = e.touches[1]!
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    const midX = (a.clientX + b.clientX) / 2
    const rect = e.currentTarget.getBoundingClientRect()
    const plotW = Math.max(1, rect.width - gutterW - PAD)
    const frac = Math.min(1, Math.max(0, (midX - rect.left - gutterW) / plotW))
    gestureRef.current = {
      kind: 'pinch',
      startDist: Math.max(1, dist),
      startSpan: view.t1 - view.t0,
      pivot: view.t0 + frac * (view.t1 - view.t0),
      origin: view,
    }
  }

  const onTouchMove: TouchEventHandler<TraceSurface> = (e) => {
    const g = gestureRef.current
    if (!g || g.kind !== 'pinch' || !tr || e.touches.length !== 2) return
    e.preventDefault()
    const a = e.touches[0]!
    const b = e.touches[1]!
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    const factor = g.startDist / Math.max(1, dist)
    const nextSpan = clampWindowNs(tr, g.startSpan * factor)
    if (followRef.current) {
      setLiveWindowNs(nextSpan)
      setView(livePinnedView(tr, nextSpan))
      return
    }
    const frac =
      g.origin.t1 > g.origin.t0 ? (g.pivot - g.origin.t0) / (g.origin.t1 - g.origin.t0) : 0.5
    const t0 = g.pivot - nextSpan * frac
    setView(clampView(tr, t0, t0 + nextSpan))
  }

  const onTouchEnd: TouchEventHandler<TraceSurface> = (e) => {
    if (e.touches.length < 2 && gestureRef.current?.kind === 'pinch') {
      gestureRef.current = null
    }
  }

  const canvasHandlers = {
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  }

  if (!tr) return null

  const tipAnchorX =
    playhead && snapTs != null && canvasRef.current && view
      ? xAt(
          { labelW: LABEL_W, pad: PAD, view0: view.t0, view1: view.t1, t0: tr.t0 },
          canvasRef.current.clientWidth,
          snapTs,
        )
      : (playhead?.x ?? 0)

  const boxZoomLabel = (() => {
    if (!boxZoomPreview || !view) return ''
    const next = viewFromBoxSelection(
      view,
      boxZoomPreview.cssW,
      gutterW,
      PAD,
      boxZoomPreview.x0,
      boxZoomPreview.x1,
      1,
    )
    if (!next) return 'zoom'
    return fmtTime(next.t1 - next.t0)
  })()

  const boxZoomOverlay = boxZoomPreview ? (
    <BoxZoomOverlay preview={boxZoomPreview} gutterW={gutterW} label={boxZoomLabel} />
  ) : null

  const boxZoomToggle = (
    <button
      type="button"
      title={
        boxZoomMode
          ? 'Box zoom on — drag to zoom, Shift-drag to pan (Esc cancels)'
          : 'Box zoom — drag a time range (or hold Shift while dragging)'
      }
      aria-label="Box zoom"
      aria-pressed={boxZoomMode}
      onClick={() => setBoxZoomMode((v) => !v)}
      className={cn(
        'rounded p-0.5 touch-manipulation',
        boxZoomMode
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      <BoxSelect className="size-3.5" />
    </button>
  )

  // Compact chrome sits immediately above the time chart (Timeline / Net canvas,
  // or between the msgq flow graph and depth chart) — same idiom as CAN lanes.
  const chartToolbar = (
    <div className="flex items-center gap-0.5 px-0.5">
      <button
        type="button"
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => applyZoom(ZOOM_IN)}
        className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
      >
        <ZoomIn className="size-3.5" />
      </button>
      <button
        type="button"
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => applyZoom(ZOOM_OUT)}
        className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
      >
        <ZoomOut className="size-3.5" />
      </button>
      {boxZoomToggle}
      <button
        type="button"
        title="Fit entire trace"
        aria-label="Fit entire trace"
        onClick={fitAll}
        className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          title="Pan earlier"
          aria-label="Pan earlier"
          onClick={() => panByFraction(-0.6)}
          className="rounded px-1 py-0.5 font-mono text-xs leading-none text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
        >
          ‹
        </button>
        <button
          type="button"
          title="Pan later"
          aria-label="Pan later"
          onClick={() => panByFraction(0.6)}
          className="rounded px-1 py-0.5 font-mono text-xs leading-none text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
        >
          ›
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
      <div className="flex gap-0.5 px-0.5">
        {(
          [
            ['schedule', 'Timeline'],
            ['queues', 'Message Queues'],
            ['net', 'Networking'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide',
              tab === id
                ? 'bg-secondary text-foreground'
                : 'text-foreground/55 hover:bg-muted/60 hover:text-foreground',
            )}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'queues' && view ? (
        <QueuesView
          tr={tr}
          view0={view.t0}
          view1={view.t1}
          follow={follow}
          eventCount={snap.revision}
          svgRef={queuesSvgRef}
          surfaceProps={canvasHandlers}
          toolbar={chartToolbar}
          overlay={boxZoomOverlay}
          boxZoomArmed={boxZoomArmed}
        />
      ) : tab === 'net' && view ? (
        <div className="flex flex-col gap-1">
          {chartToolbar}
          <NetView
            tr={tr}
            view0={view.t0}
            view1={view.t1}
            follow={follow}
            eventCount={snap.revision}
            canvasRef={netCanvasRef}
            canvasProps={canvasHandlers}
            overlay={boxZoomOverlay}
            boxZoomArmed={boxZoomArmed}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-0.5 px-0.5">
              <button
                type="button"
                title="Zoom in"
                aria-label="Zoom in"
                onClick={() => applyZoom(ZOOM_IN)}
                className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
              >
                <ZoomIn className="size-3.5" />
              </button>
              <button
                type="button"
                title="Zoom out"
                aria-label="Zoom out"
                onClick={() => applyZoom(ZOOM_OUT)}
                className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
              >
                <ZoomOut className="size-3.5" />
              </button>
              {boxZoomToggle}
              <button
                type="button"
                title="Fit entire trace"
                aria-label="Fit entire trace"
                onClick={fitAll}
                className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
              >
                <Maximize2 className="size-3.5" />
              </button>
              <button
                type="button"
                title="Show msgq edges"
                aria-label="Show msgq edges"
                aria-pressed={showMsgq}
                onClick={() => setShowMsgq((v) => !v)}
                className={cn(
                  'rounded p-0.5 touch-manipulation',
                  showMsgq
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Waypoints className="size-3.5" />
              </button>
              <Select value={laneSize} onValueChange={(v) => setLaneSize(v as LaneSize)}>
                <SelectTrigger
                  className="h-6 w-[5.75rem] touch-manipulation border-0 bg-transparent px-1.5 text-[10px] shadow-none hover:bg-secondary"
                  aria-label="Lane height"
                  title="Lane height"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LANE_SIZES) as LaneSize[]).map((id) => (
                    <SelectItem key={id} value={id} className="text-[11px]">
                      {LANE_SIZES[id].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  title="Pan earlier"
                  aria-label="Pan earlier"
                  onClick={() => panByFraction(-0.6)}
                  className="rounded px-1 py-0.5 font-mono text-xs leading-none text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
                >
                  ‹
                </button>
                <button
                  type="button"
                  title="Pan later"
                  aria-label="Pan later"
                  onClick={() => panByFraction(0.6)}
                  className="rounded px-1 py-0.5 font-mono text-xs leading-none text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
                >
                  ›
                </button>
              </div>
            </div>
            <div className="relative w-full select-none">
              <canvas
                ref={canvasRef}
                className={cn(
                  'w-full touch-none select-none rounded border border-border/60 bg-slate-950/40',
                  boxZoomArmed ? 'cursor-crosshair' : 'cursor-crosshair active:cursor-grabbing',
                )}
                {...canvasHandlers}
                onPointerMove={(e) => {
                  canvasHandlers.onPointerMove(e)
                  if (!view || !tr || e.buttons !== 0) {
                    if (playheadRef.current) setPlayhead(null)
                    return
                  }
                  const rect = e.currentTarget.getBoundingClientRect()
                  const x = e.clientX - rect.left
                  const y = e.clientY - rect.top
                  const maxX = e.currentTarget.clientWidth - PAD
                  if (x < LABEL_W && y >= AXIS_H) {
                    // Gutter hover — tip shows the full thread name; keep last ts or live edge.
                    const ts = playheadRef.current?.ts ?? view.t1
                    setPlayhead({ ts, x, y })
                    return
                  }
                  if (x < LABEL_W || x > maxX) {
                    setPlayhead(null)
                    return
                  }
                  const ts = tsAt(
                    { labelW: LABEL_W, pad: PAD, view0: view.t0, view1: view.t1, t0: tr.t0 },
                    e.currentTarget.clientWidth,
                    x,
                  )
                  setPlayhead({ ts, x, y })
                }}
                onPointerLeave={() => setPlayhead(null)}
              />
              {boxZoomOverlay}
              {scheduleTip && playhead && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute z-10 select-none rounded border border-border/70 bg-background/95 px-2 py-1 font-mono text-[10px] leading-snug text-foreground shadow-md backdrop-blur-sm"
                  style={{
                    left:
                      playhead.x < LABEL_W
                        ? LABEL_W + 8
                        : tipAnchorX > LABEL_W + 160
                          ? tipAnchorX - 10
                          : tipAnchorX + 10,
                    top: Math.max(AXIS_H + 4, playhead.y + 8),
                    transform:
                      playhead.x < LABEL_W
                        ? undefined
                        : tipAnchorX > LABEL_W + 160
                          ? 'translateX(-100%)'
                          : undefined,
                  }}
                >
                  {scheduleTip.map((line, i) => (
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
          </div>

          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            Hover for playhead · drag to pan · Shift-drag (or box-zoom tool) to zoom a range ·
            pinch or ± to zoom (keeps LIVE) · tap a lane name to select
            {showMsgq
              ? ' · click a msgq edge to pin it'
              : ''}
          </p>

          {/* Colour legend — thread states + optional msgq marks. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
            <span className="text-foreground/80">states:</span>
            {(Object.keys(STATE_LABEL) as ThreadState[])
              .filter((s) => s !== 'dead')
              .map((s) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span
                    className="inline-block size-2.5 rounded-sm"
                    style={{ background: STATE_COLOR[s] }}
                  />
                  {STATE_LABEL[s]}
                </span>
              ))}
            {showMsgq && (
              <>
                <span className="text-border">|</span>
                <span className="text-foreground/80">msgq:</span>
                {(
                  [
                    ['put', 'put →'],
                    ['put_front', 'front →'],
                    ['get', 'get ←'],
                  ] as const
                ).map(([op, label]) => (
                  <span key={op} className="inline-flex items-center gap-1">
                    <span
                      className="inline-block h-2.5 w-1 rounded-sm"
                      style={{ background: msgqOpColor(op) }}
                    />
                    {label}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-3 rounded-sm bg-sky-400/30" />
                  depth
                </span>
              </>
            )}
          </div>

          {/* Metrics line — CPU busy + ctxsw over the visible window. */}
          {stats && (
            <div className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <span className="text-foreground">CPU {(cpuBusy * 100).toFixed(0)}%</span>
              {' · '}
              <span>
                ctxsw {switches}
                {secs > 0 ? ` (${(switches / secs).toFixed(0)}/s)` : ''}
              </span>
              {' · '}
              <span className="text-foreground">window {fmtTime(stats.spanNs)}</span>
              {snap.desync && (
                <span className="ml-2 text-amber-500">desync — unknown CTF id</span>
              )}
            </div>
          )}

          {/* Info strip — running thread + selected lane at playhead (or right edge). */}
          <div className="rounded border border-border/50 bg-muted/20 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <div>
              <span className="text-muted-foreground">running: </span>
              <span className="font-mono text-foreground">
                {runningTid !== null ? threadLabel(tr, runningTid) : '(none)'}
              </span>
              {runningTid !== null && (
                <span className="ml-1 font-mono opacity-70">0x{runningTid.toString(16)}</span>
              )}
            </div>
            {lane !== null && (
              <div className="mt-0.5">
                <span className="text-muted-foreground">lane: </span>
                <span className="font-mono text-foreground">{threadLabel(tr, lane)}</span>
                {lanePrio != null && (
                  <span
                    className="ml-1.5 font-mono tabular-nums text-foreground/70"
                    title="Scheduler priority (negative = cooperative)"
                  >
                    <span className="text-muted-foreground">prio </span>
                    {lanePrio}
                  </span>
                )}
                {st && (
                  <>
                    {' → '}
                    <span style={{ color: STATE_COLOR[st] }}>
                      {st === 'blk' && reason
                        ? `blocked on ${reason}`
                        : st === 'slp' && reason
                          ? reason
                          : STATE_LABEL[st]}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
