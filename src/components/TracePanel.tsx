/**
 * Live Zephyr CTF Trace panel — Timeline Gantt + Queues + Networking.
 *
 * Timeline: thread lanes coloured by run / ready / blocked / sleep / suspended,
 * with a shared live-follow time window (pan / zoom / pinch / Shift-drag box
 * zoom). Optional queue swim lanes line data-passing objects (msgq / fifo /
 * lifo / k_queue / k_stack) under the threads, with dotted put/get connectors
 * from the actor context to each queue rail. Lane groups (THREADS, QUEUES, …)
 * carry small uppercase section headers. Queues: per-object flow graph + depth
 * from put/put_front/get exits.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEventHandler,
  type ReactNode,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react'
import {
  BatteryLow,
  BoxSelect,
  Crosshair,
  Maximize2,
  UnfoldVertical,
  Waypoints,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { QueuesView, QUEUES_LABEL_W, QUEUES_TOP_H, QUEUES_BOTTOM_AXIS_H } from '@/components/QueuesView'
import { NetView, NET_LABEL_W } from '@/components/NetView'
import { PowerView, POWER_LABEL_W } from '@/components/PowerView'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  PM_NOTCH_COLOR,
  PM_RAMP,
  STATE_COLOR,
  STATE_LABEL,
  contextSwitchesIn,
  cpuPowerLanes,
  decisionsInView,
  depthAt,
  forEachPmInView,
  fmtTime,
  isrActiveAt,
  isPutOp,
  pmFill,
  pmStateAtOrOpen,
  pmWindowStats,
  msgqOpColor,
  queueActorKey,
  queueActorLabel,
  queueAxisMax,
  queueChartOpLabel,
  queueFlowEffectTs,
  queueFlowEvents,
  queueLabel,
  reconstructQueues,
  sortQueuesByPipelineOrder,
  stateAt,
  threadLabel,
  threadPrio,
  threadRunningAt,
  visibleLanes,
  windowStats,
  forEachStateInView,
  type CpuPowerTimelines,
  type QueueFlowEvent,
  type QueueSeries,
  type ThreadState,
  type Trace,
} from '@/ctf'
import {
  dtRankCount,
  dtRankOf,
  findDtState,
  pmTupleLabel,
  type PowerStatesInfo,
} from '@/dts'
import {
  applyYZoomTransform,
  clampPlotX,
  clampPlotY,
  formatGuestTime,
  isIdentityYZoom,
  paintCanvasTimeAxis,
  paintPlayhead,
  panYZoom,
  plotWidth,
  screenYToBase,
  tsAt,
  viewFromBoxSelection,
  wantsBoxZoom,
  windowTimeStep,
  xAt,
  yZoomFromScreenSelection,
  type TraceTimeLayout,
  type YZoom,
} from '@/components/traceChart'
import { get as getDeviceTree, subscribe as subscribeDeviceTree } from '@/devicetree'
import { readPowerStates } from '@/dts'
import { getSnapshot, requestDetailUpdates, subscribe } from '@/hostTrace'
import * as debugUi from '@/lib/debugUi'
import * as hostGdb from '@/hostGdb'
import type { ObjectCoreSnapshot } from '@/debug/kernel/objectCores'
import { ProbeSection } from '@/components/ProbeSection'
import {
  STAGE_TRACE_KEY,
  getState,
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

/** Known Timeline lane groups (cpu power + threads + data-passing queues). */
type TimelineSectionId = 'cpu' | 'threads' | 'msgq'

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

/**
 * Queue swim lanes stay ~1.5× thread height at every size.
 *
 * CPU rows go the other way and are clamped to 14..24. Queue lanes scale up
 * because they draw a depth histogram that gains from height; a CPU row draws a
 * two-level bar that gains nothing above ~24px, and at Tall a 40px band would
 * dominate a section that is meant to be read at a glance and then ignored.
 */
function laneMetricsFor(size: LaneSize): LaneMetrics {
  const laneH = LANE_SIZES[size].thread
  return {
    laneH,
    msgqLaneH: Math.round(laneH * 1.5),
    cpuLaneH: Math.min(24, Math.max(14, laneH)),
  }
}

type TraceTab = 'schedule' | 'queues' | 'net' | 'power'

type MsgqSwimLane = { id: number; label: string; kind: string; series: QueueSeries }

type LaneMetrics = { laneH: number; msgqLaneH: number; cpuLaneH: number }

type TimelineGeom = {
  lanes: number[]
  hasIsr: boolean
  /** All painted groups in top→bottom order (headers + lanes). */
  sections: TimelineSection[]
  /** CPU power rows, one per cpu id seen. Empty when the guest has no PM. */
  cpus: number[]
  showCpu: boolean
  cpuTop: number
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
  cpuLaneH: number
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

const IPC_KINDS = new Set(['msgq', 'fifo', 'lifo', 'queue', 'stack'])

type IpcObjectMetadata = {
  names: Map<number, string>
  capacities: Map<number, number>
}

function ipcObjectMetadata(objects: ObjectCoreSnapshot | null): IpcObjectMetadata {
  const names = new Map<number, string>()
  const capacities = new Map<number, number>()
  for (const o of hostGdb.getWaitObjects()) {
    if (
      (o.kind && IPC_KINDS.has(o.kind)) ||
      /msgq|fifo|lifo|k_stack/.test(o.name.toLowerCase()) ||
      o.name.startsWith('q_')
    ) {
      names.set(o.addr, o.name)
    }
  }
  for (const o of hostGdb.getWaitObjects()) {
    if (!names.has(o.addr)) names.set(o.addr, o.name)
  }

  for (const type of objects?.types ?? []) {
    if (!['MSGQ', 'FIFO', 'LIFO', 'STCK'].includes(type.code)) continue
    for (const object of type.objects) {
      names.set(object.addr, object.name)
      if (object.capacity != null && object.capacity > 0) {
        capacities.set(object.addr, object.capacity)
      }
    }
  }
  return { names, capacities }
}

/** Stable queue swim lanes for Timeline overlay — pipeline order, named when known. */
function msgqSwimLanes(flow: QueueFlowEvent[], queues: QueueSeries[]): MsgqSwimLane[] {
  const seen = new Set(flow.map((ev) => ev.queueId))
  if (seen.size === 0) return []
  return queues
    .filter((q) => seen.has(q.id))
    .map((q) => ({ id: q.id, label: queueLabel(q), kind: q.kind, series: q }))
}

/**
 * An options object rather than positional arguments because the counts are the
 * transposable part: `queueCount` and any sibling count are both plain numbers,
 * and this is called from five places.
 */
type TimelineGeomOpts = {
  tr: Trace
  showMsgq: boolean
  queueCount: number
  metrics: LaneMetrics
  /** Off hides the CPU section even when the guest has PM events. */
  showCpu?: boolean
}

function timelineGeom({
  tr,
  showMsgq,
  queueCount,
  metrics,
  showCpu = true,
}: TimelineGeomOpts): TimelineGeom {
  const lanes = visibleLanes(tr)
  const hasIsr = tr.isrSpans.length > 0 || tr.isrOpenStart != null
  const showQueues = showMsgq && queueCount > 0
  const threadBlockRows = lanes.length + (hasIsr ? 1 : 0)

  /*
   * CPU power sits above THREADS. Top-to-bottom then reads substrate → actors →
   * objects, but the load-bearing reason is positional stability: visibleLanes()
   * grows as threads are created during boot, so a section *below* the threads
   * would slide downward while someone is watching it in a live view that
   * repaints every 500 ms. Above them it is pinned at a constant y.
   *
   * Conditional on data exactly like showQueues and hasIsr below, so a guest
   * without CONFIG_PM gets a byte-identical panel — no header, no lane, no shift.
   */
  const cpus = showCpu ? cpuPowerLanes(tr.cpuPower) : []
  const showCpuSection = cpus.length > 0
  const sections: TimelineSection[] = []

  let cursor = AXIS_H
  let cpuTop = cursor
  if (showCpuSection) {
    const cpuHeaderTop = cursor
    cpuTop = cpuHeaderTop + SECTION_HEADER_H
    const cpuBottom = cpuTop + cpus.length * metrics.cpuLaneH
    sections.push({
      id: 'cpu',
      title: 'CPU',
      headerTop: cpuHeaderTop,
      lanesTop: cpuTop,
      laneH: metrics.cpuLaneH,
      rowCount: cpus.length,
      bottom: cpuBottom,
    })
    cursor = cpuBottom + SECTION_GAP
  }

  const threadsHeaderTop = cursor
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

  sections.push(threads)
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
      title: 'QUEUES',
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
    cpus,
    showCpu: showCpuSection,
    cpuTop,
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
    cpuLaneH: metrics.cpuLaneH,
  }
}

/** What the CPU band needs to draw and label itself. */
type CpuPaint = {
  timelines: CpuPowerTimelines
  /** Devicetree ladder, when the build declares one. Supplies names and rank. */
  dt: PowerStatesInfo | null
}

/**
 * One band per CPU: fill is the state, a 2px baseline notch strip marks the
 * instants the policy looked and declined to sleep.
 *
 * ACTIVE draws nothing at all — not grey, not a hairline. It is a gap, and the
 * lane trough showing through *is* the encoding, which is what keeps a row quiet
 * on a guest that is mostly awake.
 */
function paintCpuPower(
  ctx: CanvasRenderingContext2D,
  cpu: CpuPaint,
  geom: TimelineGeom,
  layout: TraceTimeLayout,
  cssW: number,
  view0: number,
  view1: number,
  plotW: number,
  /**
   * Where the gutter reads its "state right now" from. The caller clamps this to
   * the last event: every transition emits one, so the state after the final
   * event is *known* — whatever was last entered — and a guest that parks in
   * standby forever simply stops producing events. Probing past it would find no
   * segment and report the CPU awake, the one thing it certainly is not.
   */
  probeTs: number,
) {
  const { cpuLaneH, cpuTop, cpus } = geom

  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(LABEL_W, cpuTop, plotW, cpus.length * cpuLaneH)

  cpus.forEach((id, row) => {
    const y = cpuTop + row * cpuLaneH
    const fillTop = y + 2
    const fillH = Math.max(4, cpuLaneH - 7)
    const notchY = y + cpuLaneH - 4
    const rankCount = cpu.dt ? dtRankCount(cpu.dt, id) : 0

    // Exact ns→x, not the column raster: the transition is the thing worth being
    // accurate about, and one band does not need the raster's speed.
    forEachPmInView(cpu.timelines, id, view0, view1, (start, end, state, sub) => {
      const rank = (cpu.dt && dtRankOf(cpu.dt, id, state, sub)) ?? state
      const { fill, full } = pmFill(rank, rankCount, state)
      const x0 = xAt(layout, cssW, start)
      const x1 = xAt(layout, cssW, end)
      const w = Math.max(1, x1 - x0)
      const h = full ? fillH : Math.max(3, Math.round(fillH * 0.6))
      ctx.fillStyle = fill
      ctx.fillRect(x0, fillTop + (fillH - h), w, h)
    })

    // Policy declines, pixel-thinned exactly like the msgq marks.
    ctx.fillStyle = PM_NOTCH_COLOR
    let lastNotchX = -Infinity
    for (const decision of decisionsInView(cpu.timelines, view0, view1)) {
      if (!decision.declined || decision.cpu !== id) continue
      const x = xAt(layout, cssW, decision.ts)
      if (x - lastNotchX < MSGQ_MARK_MIN_GAP_PX) continue
      lastNotchX = x
      ctx.fillRect(x, notchY, 2, 2)
    }

    // Gutter: name left, state at the playhead right — the same two-part idiom
    // the queue gutter uses for live depth.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const now = pmStateAtOrOpen(cpu.timelines, id, probeTs)
    const nowLabel = now
      ? pmTupleLabel(
          cpu.dt ? findDtState(cpu.dt, id, now.state, now.substateId) : null,
          now.state,
          now.substateId,
        )
      : '—'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    const nowW = ctx.measureText(nowLabel).width
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(fitLabel(ctx, `cpu${id}`, LABEL_W - PAD * 2 - nowW - 6), PAD, y + cpuLaneH / 2)

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'right'
    if (now) {
      const rank = (cpu.dt && dtRankOf(cpu.dt, id, now.state, now.substateId)) ?? now.state
      ctx.fillStyle = pmFill(rank, rankCount, now.state).fill
    } else {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)'
    }
    ctx.fillText(nowLabel, LABEL_W - PAD, y + cpuLaneH / 2)
    ctx.textAlign = 'left'
  })
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
  if (series.cap == null || series.cap <= 0) return String(d)
  return series.capSource === 'inferred' ? `${d}/~${series.cap}` : `${d}/${series.cap}`
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
  /** Must match what paint() used, or every row is offset by the CPU section. */
  showCpu: boolean,
  queueLanes: MsgqSwimLane[],
  msgqEvents: QueueFlowEvent[],
  metrics: LaneMetrics,
  /** Max |Δt| in raw CTF ns for snapping to a flow event. */
  maxDeltaNs: number,
): MsgqHover | null {
  if (!playhead || !showMsgq) return null
  const geom = timelineGeom({ tr, showMsgq, queueCount: queueLanes.length, metrics, showCpu })
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

const TRACE_TABS = ['schedule', 'queues', 'net', 'power'] as const satisfies readonly TraceTab[]

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

/**
 * Everything one Timeline repaint needs.
 *
 * An options object, and grouped per feature, because this grew to fifteen
 * positional parameters across two call sites — one of which mirrored them
 * through eight refs, and had already drifted (it read `follow` and
 * `selectedLane` from its own dependency array while taking everything else from
 * refs). One object assigned per render means there is only one thing to keep in
 * sync, and a new feature arrives as one key rather than two more positions.
 */
type TimelinePaint = {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  selectedLane: number | null
  playheadTs: number | null
  metrics: LaneMetrics
  yZoom: YZoom | null
  msgq: {
    show: boolean
    events: QueueFlowEvent[]
    lanes: MsgqSwimLane[]
    hover: MsgqHover | null
    /** When set, playhead snaps to this raw CTF ns (tip event). */
    snapTs: number | null
    /** Sticky click-selected msgq edge (event index). */
    selectedEdge: number | null
  }
  /** Absent when the toggle is off; the section then does not exist at all. */
  cpu?: CpuPaint
}

function paint(canvas: HTMLCanvasElement, p: TimelinePaint) {
  const { tr, view0, view1, follow, selectedLane, playheadTs, metrics, yZoom } = p
  const { show: showMsgq, events: msgqEvents, lanes: queueLanes, hover } = p.msgq
  const { snapTs, selectedEdge } = p.msgq
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const geom = timelineGeom({
    tr,
    showMsgq,
    queueCount: queueLanes.length,
    metrics,
    showCpu: p.cpu != null,
  })
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
  const layout = { labelW: LABEL_W, pad: PAD, view0, view1, t0: tr.t0 }
  const depthProbeTs = snapTs ?? playheadTs ?? view1
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

  // Vertical box-zoom magnifies the lane stack below the time axis.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, AXIS_H, cssW, Math.max(1, cssH - AXIS_H))
  ctx.clip()
  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  for (const section of geom.sections) {
    paintSectionHeader(ctx, section.title, section.headerTop, cssW)
  }

  // --- CPU power band ----------------------------------------------------
  if (p.cpu && geom.showCpu) {
    const cpuProbeTs = Math.min(depthProbeTs, tr.t1)
    paintCpuPower(ctx, p.cpu, geom, layout, cssW, view0, view1, plotW, cpuProbeTs)
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

    // Exact ns→x ranges so ready/run edges line up with queue marks (column
    // rasterisation used to smear transitions up to one column early).
    forEachStateInView(tr, tid, view0, view1, (s, e, st) => {
      const x0 = LABEL_W + ((s - view0) / span) * plotW
      const x1 = LABEL_W + ((e - view0) / span) * plotW
      ctx.fillStyle = STATE_COLOR[st]
      ctx.globalAlpha = st === 'run' ? 1 : 0.78
      ctx.fillRect(x0, y + 3, Math.max(1, x1 - x0), laneH - 6)
    })
    ctx.globalAlpha = 1
  })

  if (hasIsr) {
    const y = lanesTop + lanes.length * laneH
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText('[ISR]', 4, y + laneH / 2)
    const isrSpans =
      tr.isrOpenStart == null
        ? tr.isrSpans
        : [...tr.isrSpans, [tr.isrOpenStart, Math.max(tr.isrOpenStart, tr.t1)] as [number, number]]
    for (const [s, e] of isrSpans) {
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
        const samples = q.series.samples

        // Exact ns→x ranges (same as thread states). Flow connectors use the
        // operation effect/exit clock below, matching these depth steps.
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i]!
          const e = i + 1 < samples.length ? samples[i + 1]!.ts : view1
          if (e <= view0 || s.ts >= view1 || s.depth <= 0) continue
          const x0 = LABEL_W + ((Math.max(s.ts, view0) - view0) / span) * plotW
          const x1 = LABEL_W + ((Math.min(e, view1) - view0) / span) * plotW
          const h = Math.max(1.5, (s.depth / yMax) * innerH)
          ctx.fillStyle = laneHot ? 'rgba(56, 189, 248, 0.45)' : 'rgba(56, 189, 248, 0.28)'
          ctx.fillRect(x0, y + msgqLaneH - innerPad - h, Math.max(1, x1 - x0), h)
        }

        ctx.fillStyle = laneHot ? 'rgba(186, 230, 253, 1)' : 'rgba(125, 211, 252, 0.9)'
        ctx.textBaseline = 'middle'
        const depthStr = depthLabel(q.series, depthProbeTs)
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        const depthW = ctx.measureText(depthStr).width
        const nameMaxW = LABEL_W - 4 - depthW - 10
        const dual = msgqLaneH >= 30
        if (dual) {
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
          ctx.fillStyle = laneHot ? 'rgba(186, 230, 253, 0.75)' : 'rgba(125, 211, 252, 0.55)'
          ctx.fillText(fitLabel(ctx, q.kind, nameMaxW), 4, y + msgqLaneH / 2 - 7)
          ctx.font = `${laneHot ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
          ctx.fillStyle = laneHot ? 'rgba(186, 230, 253, 1)' : 'rgba(125, 211, 252, 0.9)'
          ctx.fillText(fitLabel(ctx, q.label, nameMaxW), 4, y + msgqLaneH / 2 + 6)
        } else {
          const laneLabel = q.kind === 'msgq' ? q.label : `${q.kind} ${q.label}`
          ctx.font = `${laneHot ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
          ctx.fillText(fitLabel(ctx, laneLabel, nameMaxW), 4, y + msgqLaneH / 2)
        }
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
      const effectTs = queueFlowEffectTs(ev)
      if (effectTs < view0 || effectTs > view1 || ev.actor.kind === 'unknown') continue
      if (ev.actor.kind === 'thread' && !threadRowOf.has(ev.actor.threadId)) continue
      if (ev.actor.kind === 'isr' && !hasIsr) continue
      const thinKey = `${queueActorKey(ev.actor)}|${ev.queueId}`
      const x = LABEL_W + ((effectTs - view0) / span) * plotW
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
      const actorY =
        ev.actor.kind === 'thread'
          ? lanesTop + threadRowOf.get(ev.actor.threadId)! * laneH + laneH / 2
          : lanesTop + lanes.length * laneH + laneH / 2
      const x = LABEL_W + ((queueFlowEffectTs(ev) - view0) / span) * plotW
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

      if (queueY != null && Math.abs(queueY - actorY) > markR * 2 + arrowH) {
        // put: thread ○ →↓ queue    get: queue ○ →↑ thread
        // Timestamps are raw CTF ns; x is a pure linear map of those ns.
        const startY = put ? actorY : queueY
        const tipY = put ? queueY : actorY
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
          actorY - laneH / 2 + 2,
          actorY + laneH / 2 - 2,
          color,
          kind,
          zw,
        )
        paintMsgqMark(ctx, x, actorY, markR, color, kind)
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

  ctx.restore()

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
    const effectTs = queueFlowEffectTs(ev)
    if (effectTs < view0 || effectTs > view1) continue
    const d = Math.abs(effectTs - ts)
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
  /** Must match what paint() used, or every row is offset by the CPU section. */
  showCpu: boolean,
  msgqEvents: QueueFlowEvent[],
  queueLanes: MsgqSwimLane[],
  metrics: LaneMetrics,
): number | null {
  if (!showMsgq || queueLanes.length === 0) return null
  const geom = timelineGeom({ tr, showMsgq, queueCount: queueLanes.length, metrics, showCpu })
  if (!geom.showQueues) return null
  const plotW = plotWidth(cssW, LABEL_W, PAD)
  const span = Math.max(1, view1 - view0)
  const threadRowOf = new Map(geom.lanes.map((tid, row) => [tid, row]))
  const queueRowOf = new Map(queueLanes.map((q, row) => [q.id, row]))

  let best: number | null = null
  let bestDist = MSGQ_EDGE_HIT_PX
  const lastXByKey = new Map<string, number>()
  for (const ev of msgqEvents) {
    const effectTs = queueFlowEffectTs(ev)
    if (effectTs < view0 || effectTs > view1 || ev.actor.kind === 'unknown') continue
    const actorY =
      ev.actor.kind === 'thread'
        ? (() => {
            const row = threadRowOf.get(ev.actor.threadId)
            return row == null ? null : geom.lanesTop + row * geom.laneH + geom.laneH / 2
          })()
        : geom.hasIsr
          ? geom.lanesTop + geom.lanes.length * geom.laneH + geom.laneH / 2
          : null
    const qRow = queueRowOf.get(ev.queueId)
    if (actorY == null || qRow == null) continue
    const ex = LABEL_W + ((effectTs - view0) / span) * plotW
    const thinKey = `${queueActorKey(ev.actor)}|${ev.queueId}`
    const prev = lastXByKey.get(thinKey)
    if (prev != null && ex - prev < MSGQ_MARK_MIN_GAP_PX) continue
    lastXByKey.set(thinKey, ex)
    const queueY = geom.queueTop + qRow * geom.msgqLaneH + geom.msgqLaneH / 2
    const y0 = Math.min(actorY, queueY)
    const y1 = Math.max(actorY, queueY)
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
      startY: number
      origin: { t0: number; t1: number }
      originYZoom: YZoom | null
      moved: boolean
    }
  | {
      kind: 'boxZoom'
      pointerId: number
      /** Local coords within the surface (CSS px). */
      startX: number
      startY: number
      origin: { t0: number; t1: number }
      originYZoom: YZoom | null
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
type BoxZoomPreview = {
  x0: number
  x1: number
  y0: number
  y1: number
  cssW: number
  cssH: number
  plotTop: number
}

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
  const plotTop = preview.plotTop
  const plotBottom = Math.max(plotTop + 1, preview.cssH)
  const left = Math.min(
    clampPlotX(preview.x0, preview.cssW, gutterW, PAD),
    clampPlotX(preview.x1, preview.cssW, gutterW, PAD),
  )
  const right = Math.max(
    clampPlotX(preview.x0, preview.cssW, gutterW, PAD),
    clampPlotX(preview.x1, preview.cssW, gutterW, PAD),
  )
  const top = Math.min(
    clampPlotY(preview.y0, plotTop, plotBottom),
    clampPlotY(preview.y1, plotTop, plotBottom),
  )
  const bottom = Math.max(
    clampPlotY(preview.y0, plotTop, plotBottom),
    clampPlotY(preview.y1, plotTop, plotBottom),
  )
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden rounded">
      {/* Dim outside the selection, inside the plot band. */}
      <div
        className="absolute bg-slate-950/50"
        style={{ left: plotLeft, top: plotTop, width: Math.max(0, plotRight - plotLeft), height: Math.max(0, top - plotTop) }}
      />
      <div
        className="absolute bg-slate-950/50"
        style={{ left: plotLeft, top: bottom, width: Math.max(0, plotRight - plotLeft), height: Math.max(0, plotBottom - bottom) }}
      />
      <div
        className="absolute bg-slate-950/50"
        style={{ left: plotLeft, top, width: Math.max(0, left - plotLeft), height }}
      />
      <div
        className="absolute bg-slate-950/50"
        style={{ left: right, top, width: Math.max(0, plotRight - right), height }}
      />
      <div
        className="absolute border-2 border-sky-400/85 bg-sky-400/20"
        style={{ left, top, width, height }}
      >
        <div className="absolute left-1/2 top-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-sky-400 px-1.5 py-0.5 font-mono text-[9px] font-medium leading-none text-slate-950 shadow-sm">
          {label}
        </div>
      </div>
    </div>
  )
}

/** Plot band below the time axis for the active Trace tab. */
function plotBandForTab(tab: TraceTab, cssH: number): { plotTop: number; plotBottom: number } {
  if (tab === 'queues') {
    // Queues keeps a bottom time axis — zoom the row band only.
    const rowBottom = Math.max(QUEUES_TOP_H + 72, cssH - QUEUES_BOTTOM_AXIS_H)
    return { plotTop: QUEUES_TOP_H, plotBottom: rowBottom }
  }
  return { plotTop: AXIS_H, plotBottom: Math.max(AXIS_H + 1, cssH) }
}

/** CTF thread timeline / queues / networking — the body of the Trace dock row. */
export function TraceBody() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const gdbSnap = useSyncExternalStore(
    hostGdb.subscribe,
    hostGdb.getSnapshot,
    hostGdb.getSnapshot,
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ProbeSection />
      {snap.eventCount === 0 ? (
        <p className="px-3 py-4 text-[11px] text-muted-foreground">
          {snap.source === 'bridge' || snap.source === 'probe'
            ? 'Connected to the desktop bridge. Waiting for traces from the board.'
            : 'No Trace events yet. Pick a traced app, or turn on the desktop bridge in Settings.'}
        </p>
      ) : (
        <TracePanelBody snap={snap} objectCores={gdbSnap.objects} />
      )}
    </div>
  )
}

function TracePanelBody({
  snap,
  objectCores,
}: {
  snap: ReturnType<typeof getSnapshot>
  objectCores: ObjectCoreSnapshot | null
}) {
  /** Pinned to the live edge until a pan/zoom detaches the view. */
  const [follow, setFollow] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const queuesSvgRef = useRef<SVGSVGElement>(null)
  const netCanvasRef = useRef<HTMLCanvasElement>(null)
  const powerCanvasRef = useRef<HTMLCanvasElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  /** Desired live-follow window; zoom while LIVE updates this instead of detaching. */
  const [liveWindowNs, setLiveWindowNs] = useState(DEFAULT_LIVE_WINDOW_NS)
  const [view, setView] = useState<{ t0: number; t1: number } | null>(null)
  const [selectedLane, setSelectedLane] = useState<number | null>(null)
  /** Line msgq put/get/put_front marks onto thread lanes. */
  const [showMsgq, setShowMsgq] = useState(true)
  /** CPU suspend-state band. Self-gates on data, so the toggle only ever hides. */
  const [showCpu, setShowCpu] = useState(true)
  const [laneSize, setLaneSize] = useState<LaneSize>('m')
  /** Sticky click-selected msgq edge (tr.events index). */
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  /** Timeline playhead — hover ts; null when not scrubbing. */
  const [playhead, setPlayhead] = useState<{ ts: number; x: number; y: number } | null>(null)
  /**
   * Sticky box-zoom mode: drag selects a time×vertical range (Shift temporarily pans).
   * When off, plain drag pans and Shift-drag box-zooms.
   */
  const [boxZoomMode, setBoxZoomMode] = useState(false)
  const [shiftHeld, setShiftHeld] = useState(false)
  const [boxZoomPreview, setBoxZoomPreview] = useState<BoxZoomPreview | null>(null)
  /** Per-tab vertical viewport from rectangle zoom (wheel / ± leave this alone). */
  const [yZoomByTab, setYZoomByTab] = useState<Partial<Record<TraceTab, YZoom>>>({})
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const boxZoomModeRef = useRef(boxZoomMode)
  boxZoomModeRef.current = boxZoomMode
  const laneMetrics = useMemo(() => laneMetricsFor(laneSize), [laneSize])

  /*
   * The devicetree is what turns `state 3 substate 1` into `standby` and, more
   * importantly, what ranks two states that share one pm_state value. Read
   * straight from the store rather than through useDeviceTree, which derives the
   * whole dock inventory this has no use for.
   */
  const dtsTree = useSyncExternalStore(subscribeDeviceTree, getDeviceTree, () => null)
  const powerStates = useMemo(
    () => (dtsTree?.doc ? readPowerStates(dtsTree.doc) : null),
    [dtsTree],
  )
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const tab = tabIn(dock, STAGE_TRACE_KEY, TRACE_TABS, 'schedule') as TraceTab
  const setTab = (id: TraceTab) => setStoredTab(STAGE_TRACE_KEY, id)

  useEffect(() => {
    if (tab !== 'queues') return
    return requestDetailUpdates()
  }, [tab])
  const followRef = useRef(follow)
  followRef.current = follow
  const gutterW =
    tab === 'queues'
      ? QUEUES_LABEL_W
      : tab === 'net'
        ? NET_LABEL_W
        : tab === 'power'
          ? POWER_LABEL_W
          : LABEL_W
  const yZoom = yZoomByTab[tab] ?? null
  const yZoomRef = useRef(yZoom)
  yZoomRef.current = yZoom
  const boxZoomArmed = boxZoomMode || shiftHeld || boxZoomPreview != null

  const setYZoom = useCallback(
    (next: YZoom | null) => {
      setYZoomByTab((prev) => {
        if (!next || isIdentityYZoom(next)) {
          if (!(tab in prev)) return prev
          const { [tab]: _removed, ...rest } = prev
          return rest
        }
        return { ...prev, [tab]: next }
      })
    },
    [tab],
  )

  const tr = snap.trace
  const hasPm = tr != null && cpuPowerLanes(tr.cpuPower).length > 0
  const cpuPaint: CpuPaint | undefined =
    tr && showCpu && hasPm ? { timelines: tr.cpuPower, dt: powerStates } : undefined
  const ipcMetadata = useMemo(() => ipcObjectMetadata(objectCores), [objectCores])
  const msgqEvents = useMemo(
    () => (tr ? queueFlowEvents(tr) : []),
    // revision bumps whenever the event ring changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, snap.revision],
  )
  const queueSeries = useMemo(
    () => {
      if (!tr || (msgqEvents.length === 0 && tab !== 'queues')) return []
      return sortQueuesByPipelineOrder(
        tr,
        reconstructQueues(tr, ipcMetadata.names, ipcMetadata.capacities),
        msgqEvents,
      )
    },
    // Keep one queue reconstruction shared by the timeline, synoptic, and depth chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, msgqEvents, snap.revision, ipcMetadata, tab],
  )
  const queueLanes = useMemo(
    () => msgqSwimLanes(msgqEvents, queueSeries),
    [msgqEvents, queueSeries],
  )

  const msgqHover = useMemo(() => {
    if (!tr || !view || !playhead) return null
    const cssW = canvasRef.current?.clientWidth ?? 480
    const cssH = canvasRef.current?.clientHeight ?? 120
    const plotW = plotWidth(cssW, LABEL_W, PAD)
    // ~8px in raw ns — keeps tip/snap tight to the mark under the cursor.
    const maxDeltaNs = Math.max(50_000, ((view.t1 - view.t0) * 8) / Math.max(1, plotW))
    const { plotTop, plotBottom } = plotBandForTab('schedule', cssH)
    const baseY = screenYToBase(playhead.y, plotTop, plotBottom, yZoom)
    return resolveMsgqHover(
      { ts: playhead.ts, y: baseY },
      tr,
      view.t0,
      view.t1,
      showMsgq,
      cpuPaint != null,
      queueLanes,
      msgqEvents,
      laneMetrics,
      maxDeltaNs,
    )
  }, [playhead, tr, view, showMsgq, cpuPaint, queueLanes, msgqEvents, laneMetrics, yZoom])
  const snapTs = useMemo(() => {
    const idx = msgqHover?.eventIndex ?? selectedEdge
    if (idx == null) return null
    const event = msgqEvents.find((ev) => ev.index === idx)
    return event ? queueFlowEffectTs(event) : null
  }, [msgqHover, selectedEdge, msgqEvents])

  useEffect(() => {
    if (!showMsgq) setSelectedEdge(null)
  }, [showMsgq])

  useEffect(() => {
    if (!tr || tr.events.length === 0) return
    if (follow) {
      setView(livePinnedView(tr, liveWindowNs))
    }
  }, [tr, follow, liveWindowNs, snap.revision])

  /*
   * The single source of truth for a repaint. Both callers below read this, so
   * the ResizeObserver cannot drift from the render effect the way the old
   * parallel argument lists did.
   */
  const paintArgs: TimelinePaint | null =
    tr && view
      ? {
          tr,
          view0: view.t0,
          view1: view.t1,
          follow,
          selectedLane,
          playheadTs: playhead?.ts ?? null,
          metrics: laneMetrics,
          yZoom,
          msgq: {
            show: showMsgq,
            events: msgqEvents,
            lanes: queueLanes,
            hover: msgqHover,
            snapTs,
            selectedEdge,
          },
          cpu: cpuPaint,
        }
      : null
  const paintArgsRef = useRef(paintArgs)
  paintArgsRef.current = paintArgs

  useEffect(() => {
    if (tab !== 'schedule') return
    const canvas = canvasRef.current
    if (!canvas || !paintArgs) return
    paint(canvas, paintArgs)
  }, [tab, paintArgs, snap.revision])

  useEffect(() => {
    if (tab !== 'schedule') return
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const args = paintArgsRef.current
      if (args) paint(canvas, args)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tab])

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
    setYZoom(null)
    setView({ t0: tr.t0, t1: Math.max(tr.t0 + MIN_WINDOW_NS, tr.t1) })
  }, [tr, setFollow, setYZoom])

  const jumpLive = useCallback(() => {
    if (view) setLiveWindowNs(view.t1 - view.t0)
    setFollow(true)
  }, [view, setFollow])


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
  const probeInIsr = tr ? isrActiveAt(tr, probeTs) : false
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
  /**
   * Fraction of the visible window this CPU spent suspended. Null — and so
   * omitted entirely — unless the guest reported power states, so the metrics
   * line is unchanged for every build without CONFIG_PM. cpu0 only: a second
   * fraction per CPU belongs in the Power tab, not on a one-line strip.
   */
  const sleptFraction =
    tr && view && cpuPaint
      ? pmWindowStats(tr.cpuPower, cpuPaint.timelines.segs.keys().next().value ?? 0, view.t0, view.t1)
          .sleptFraction
      : null

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
    const tipTs = msgq ? queueFlowEffectTs(msgq) : playhead.ts

    // Queue-lane tip: keep it about the queue / op — not who is running.
    if (msgqHover?.overQueueLane && q) {
      const lines: string[] = []
      if (msgq) {
        const who = queueActorLabel(tr, msgq.actor)
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

    /*
     * CPU-section tip: keep it about the CPU, mirroring the queue-lane rule
     * above. The devicetree supplies everything but the timestamps — the events
     * themselves carry only three integers.
     *
     * Numbers, not grades: min-residency is a policy *input*, compared against
     * predicted idle time, so a ✓/✗ verdict on achieved residency would be a
     * confident judgement on an emulated clock. "early wake" is a fact; the
     * reader draws the conclusion.
     */
    if (cpuPaint) {
      const cssHC = canvasRef.current?.clientHeight ?? 120
      const { plotTop, plotBottom } = plotBandForTab('schedule', cssHC)
      const baseY = screenYToBase(playhead.y, plotTop, plotBottom, yZoom)
      const geom = timelineGeom({
        tr,
        showMsgq,
        queueCount: queueLanes.length,
        metrics: laneMetrics,
        showCpu: true,
      })
      const row = Math.floor((baseY - geom.cpuTop) / geom.cpuLaneH)
      if (baseY >= geom.cpuTop && row >= 0 && row < geom.cpus.length) {
        const id = geom.cpus[row]!
        const lines = [`${guest} · cpu${id}`]
        const held = pmStateAtOrOpen(cpuPaint.timelines, id, tipTs)
        if (held) {
          const dt = cpuPaint.dt
            ? findDtState(cpuPaint.dt, id, held.state, held.substateId)
            : null
          lines.push(pmTupleLabel(dt, held.state, held.substateId))
          // Still open: report elapsed-so-far rather than a residency it has not
          // finished accruing, and never call that an early wake.
          const heldNs = (held.end ?? tr.t1) - held.since
          const min = dt?.minResidencyUs
          const exit = dt?.exitLatencyUs
          const bracket = [
            min != null ? `min ${fmtTime(min * 1000)}` : null,
            exit != null && exit > 0 ? `exit ${fmtTime(exit * 1000)}` : null,
          ].filter(Boolean)
          lines.push(
            `${fmtTime(heldNs)}${bracket.length > 0 ? `  (${bracket.join(', ')})` : ''}`,
          )
          if (held.end != null && min != null && heldNs < min * 1000) {
            lines.push('early wake')
          }
        } else {
          lines.push('active')
        }
        const decision = decisionsInView(cpuPaint.timelines, view.t0, view.t1)
          .filter((d) => d.cpu === id && d.ts <= tipTs)
          .at(-1)
        if (decision?.declined) {
          lines.push(
            decision.ticks != null
              ? `policy declined · budget ${decision.ticks} ticks`
              : 'policy declined',
          )
        }
        return lines
      }
    }

    const tipRunningTid = threadRunningAt(tr, tipTs)
    const runLabel = isrActiveAt(tr, tipTs)
      ? '[ISR]'
      : tipRunningTid != null
        ? threadLabel(tr, tipRunningTid)
        : '(idle)'
    // Absolute guest CTF ns from timing_ns_get (not relative to first event).
    const lines = [`${guest} · ${runLabel}`]

    // When the pointer is over a thread lane label, show that lane’s full name.
    if (playhead.x < LABEL_W) {
      const cssH = canvasRef.current?.clientHeight ?? 120
      const { plotTop, plotBottom } = plotBandForTab('schedule', cssH)
      const baseY = screenYToBase(playhead.y, plotTop, plotBottom, yZoom)
      const geom = timelineGeom({ tr, showMsgq, queueCount: queueLanes.length, metrics: laneMetrics, showCpu: cpuPaint != null })
      const row = Math.floor((baseY - geom.lanesTop) / geom.laneH)
      if (row >= 0 && row < geom.lanes.length) {
        const tid = geom.lanes[row]!
        const full = threadLabel(tr, tid)
        const prio = threadPrio(tr, tid)
        lines.push(prio != null ? `${full} · prio ${prio}` : full)
      }
    }

    if (msgq) {
      const who = queueActorLabel(tr, msgq.actor)
      const qName = q?.label ?? `0x${msgq.queueId.toString(16)}`
      const fail = msgq.ok ? '' : ' fail'
      const arrow = isPutOp(msgq.op) ? '→' : '←'
      const depth = q ? ` · depth ${depthLabel(q.series, queueFlowEffectTs(msgq))}` : ''
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
    const localY = e.clientY - rect.top
    const cssW = e.currentTarget.clientWidth
    const cssH = e.currentTarget.clientHeight
    const { plotTop } = plotBandForTab(tab, cssH)
    const originYZoom = yZoomRef.current
    if (wantsBoxZoom(e.shiftKey, boxZoomModeRef.current)) {
      setPlayhead(null)
      setBoxZoomPreview({
        x0: localX,
        x1: localX,
        y0: localY,
        y1: localY,
        cssW,
        cssH,
        plotTop,
      })
      gestureRef.current = {
        kind: 'boxZoom',
        pointerId: e.pointerId,
        startX: localX,
        startY: localY,
        origin: view,
        originYZoom,
        moved: false,
      }
      return
    }
    gestureRef.current = {
      kind: 'pan',
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: view,
      originYZoom,
      moved: false,
    }
  }

  const onPointerMove: PointerEventHandler<TraceSurface> = (e) => {
    const g = gestureRef.current
    if (!g || g.kind === 'pinch' || g.pointerId !== e.pointerId || !tr) return
    if (g.kind === 'boxZoom') {
      const rect = e.currentTarget.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const dx = localX - g.startX
      const dy = localY - g.startY
      if (!g.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return
      g.moved = true
      window.getSelection()?.removeAllRanges()
      setPlayhead(null)
      const cssW = e.currentTarget.clientWidth
      const cssH = e.currentTarget.clientHeight
      const { plotTop } = plotBandForTab(tab, cssH)
      setBoxZoomPreview({
        x0: g.startX,
        x1: localX,
        y0: g.startY,
        y1: localY,
        cssW,
        cssH,
        plotTop,
      })
      return
    }
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return
    g.moved = true
    window.getSelection()?.removeAllRanges()
    setFollow(false)
    setPlayhead(null)
    const plotW = Math.max(1, e.currentTarget.clientWidth - gutterW - PAD)
    const span = g.origin.t1 - g.origin.t0
    const dt = (-dx / plotW) * span
    setView(clampView(tr, g.origin.t0 + dt, g.origin.t1 + dt))
    // When vertically zoomed, drag also pans the Y viewport.
    if (g.originYZoom && !isIdentityYZoom(g.originYZoom)) {
      const cssH = e.currentTarget.clientHeight
      const { plotTop, plotBottom } = plotBandForTab(tab, cssH)
      setYZoom(panYZoom(g.originYZoom, plotBottom - plotTop, dy))
    }
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
      const endY = e.clientY - rect.top
      const cssW = e.currentTarget.clientWidth
      const cssH = e.currentTarget.clientHeight
      const { plotTop, plotBottom } = plotBandForTab(tab, cssH)
      const nextT = viewFromBoxSelection(
        g.origin,
        cssW,
        gutterW,
        PAD,
        g.startX,
        endX,
        PAN_THRESHOLD_PX,
      )
      const nextY = yZoomFromScreenSelection(
        plotTop,
        plotBottom,
        g.startY,
        endY,
        g.originYZoom,
        PAN_THRESHOLD_PX,
      )
      // Need a meaningful X span; Y can optionally join for 2D zoom.
      if (!nextT) return
      setFollow(false)
      setPlayhead(null)
      setLiveWindowNs(clampWindowNs(tr, nextT.t1 - nextT.t0))
      setView(clampView(tr, nextT.t0, nextT.t1))
      if (nextY) setYZoom(nextY)
      return
    }

    if (g.moved || !view || !tr || tab !== 'schedule') return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const screenY = e.clientY - rect.top
    const cssH = e.currentTarget.clientHeight
    const { plotTop, plotBottom } = plotBandForTab('schedule', cssH)
    const y = screenYToBase(screenY, plotTop, plotBottom, yZoomRef.current)
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
        cpuPaint != null,
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
      const geom = timelineGeom({ tr, showMsgq, queueCount: queueLanes.length, metrics: laneMetrics, showCpu: cpuPaint != null })
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
    const { plotTop, plotBottom } = plotBandForTab(tab, boxZoomPreview.cssH)
    const ySpan = Math.abs(
      clampPlotY(boxZoomPreview.y1, plotTop, plotBottom) -
        clampPlotY(boxZoomPreview.y0, plotTop, plotBottom),
    )
    return ySpan >= PAN_THRESHOLD_PX ? `${fmtTime(next.t1 - next.t0)} · 2D` : fmtTime(next.t1 - next.t0)
  })()

  const boxZoomOverlay = boxZoomPreview ? (
    <BoxZoomOverlay preview={boxZoomPreview} gutterW={gutterW} label={boxZoomLabel} />
  ) : null

  const boxZoomToggle = (
    <button
      type="button"
      title={
        boxZoomMode
          ? 'Box zoom on — drag a rectangle to zoom time+vertical, Shift-drag to pan (Esc cancels)'
          : 'Box zoom — drag a rectangle to zoom time+vertical (or hold Shift while dragging)'
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

  const yZoomActive = yZoom != null && !isIdentityYZoom(yZoom)
  const resetYZoomButton = (
    <button
      type="button"
      title={yZoomActive ? 'Reset vertical zoom' : 'Vertical zoom is at full height'}
      aria-label="Reset vertical zoom"
      disabled={!yZoomActive}
      onClick={() => setYZoom(null)}
      className={cn(
        'rounded p-0.5 touch-manipulation',
        yZoomActive
          ? 'text-foreground hover:bg-secondary'
          : 'text-muted-foreground/40',
      )}
    >
      <UnfoldVertical className="size-3.5" />
    </button>
  )

  // Compact chrome sits immediately above the time chart (Timeline / Net canvas,
  // or between the msgq flow graph and depth chart) — same idiom as CAN lanes.
  /**
   * The chart chrome, shared by all three tabs.
   *
   * Timeline used to keep its own hand-written copy of this row, differing only
   * by two extra controls at the end — which is how it came to be the one tab
   * without a jump-to-live button. `extras` is those two controls; everything
   * else is written once.
   */
  const chartToolbarWith = (extras?: ReactNode) => (
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
      {resetYZoomButton}
      <button
        type="button"
        title="Fit entire trace (resets time + vertical zoom)"
        aria-label="Fit entire trace"
        onClick={fitAll}
        className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
      >
        <Maximize2 className="size-3.5" />
      </button>
      <button
        type="button"
        title={follow ? 'Following the live edge' : 'Jump to the live edge'}
        aria-label={follow ? 'Following the live edge' : 'Jump to the live edge'}
        aria-pressed={follow}
        onClick={jumpLive}
        className={cn(
          'rounded p-0.5 touch-manipulation',
          follow ? 'text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <Crosshair className="size-3.5" />
      </button>
      {extras}
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

  const chartToolbar = chartToolbarWith()

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
      <div className="flex gap-0.5 px-0.5">
        {(
          [
            ['schedule', 'Timeline'],
            ['queues', 'Queues'],
            ['net', 'Networking'],
            ['power', 'Power'],
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
          queues={queueSeries}
          flowEvents={msgqEvents}
          view0={view.t0}
          view1={view.t1}
          follow={follow}
          eventCount={snap.revision}
          svgRef={queuesSvgRef}
          surfaceProps={canvasHandlers}
          toolbar={chartToolbar}
          overlay={boxZoomOverlay}
          boxZoomArmed={boxZoomArmed}
          yZoom={yZoom}
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
            yZoom={yZoom}
          />
        </div>
      ) : tab === 'power' && view ? (
        hasPm ? (
          <PowerView
            tr={tr}
            timelines={tr.cpuPower}
            dt={powerStates}
            deviceNames={hostGdb.getDeviceNames()}
            view0={view.t0}
            view1={view.t1}
            eventCount={snap.revision}
            canvasRef={powerCanvasRef}
            canvasProps={canvasHandlers}
            overlay={boxZoomOverlay}
            boxZoomArmed={boxZoomArmed}
            yZoom={yZoom}
            toolbar={chartToolbar}
          />
        ) : (
          /* Empty states name the missing CONFIG_*, per the house convention. */
          <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            No CPU power-state events in this trace.
            <br />
            Needs a guest built with <span className="font-mono text-foreground">CONFIG_PM=y</span>{' '}
            and a <span className="font-mono text-foreground">power-states</span> node its cpu
            references — try the <span className="text-foreground">Power states · traced</span>{' '}
            sample.
          </div>
        )
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {chartToolbarWith(
              <>
                <button
                  type="button"
                  title="Show queue edges"
                  aria-label="Show queue edges"
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
                {/* Only offered when the guest has power states — a toggle for a
                    section that cannot appear is itself the clutter. */}
                {hasPm && (
                  <button
                    type="button"
                    title="Show CPU power states"
                    aria-label="Show CPU power states"
                    aria-pressed={showCpu}
                    onClick={() => setShowCpu((v) => !v)}
                    className={cn(
                      'rounded p-0.5 touch-manipulation',
                      showCpu
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    <BatteryLow className="size-3.5" />
                  </button>
                )}
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
              </>,
            )}
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

          {/*
            No gesture crib sheet here. Every one of those lines — zoom, box
            zoom, fit, unfold, pan, live — is a button in the toolbar above,
            with the gesture in its tooltip; the rest (drag to pan, hover for a
            playhead) is what a chart does. It cost more height than the chart.

            The colour legend stays: state → colour is not guessable.
          */}
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
                <span className="text-foreground/80">queues:</span>
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
            {/*
              One item, not seven. This line already carries nine on a wrapping
              10px row; a six-way ordinal scale is not something a legend is good
              at anyway, so the gradient shows the direction and the names live in
              the tooltip and the Power tab.
            */}
            {cpuPaint && (
              <>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-6 rounded-sm"
                    style={{
                      background: `linear-gradient(to right, ${PM_RAMP[0]}, ${PM_RAMP[2]}, ${PM_RAMP[5]})`,
                    }}
                  />
                  cpu sleep (deeper →)
                </span>
              </>
            )}
          </div>

          {/* Metrics line — CPU busy + ctxsw over the visible window. */}
          {stats && (
            <div className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <span className="text-foreground">CPU {(cpuBusy * 100).toFixed(0)}%</span>
              {/*
                `slept`, not a second `CPU` percentage. The two answer different
                questions and are not complements — CPU% is the host-side busy
                heuristic, this is guest-declared suspend time — so two adjacent
                percentages that sum past 100 would read as a bug.
              */}
              {sleptFraction != null && (
                <>
                  {' · '}
                  <span className="text-foreground">
                    slept {(sleptFraction * 100).toFixed(0)}%
                  </span>
                </>
              )}
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
              <span className={cn('font-mono text-foreground', probeInIsr && 'text-purple-300')}>
                {probeInIsr
                  ? '[ISR]'
                  : runningTid !== null
                    ? threadLabel(tr, runningTid)
                    : '(none)'}
              </span>
              {!probeInIsr && runningTid !== null && (
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
