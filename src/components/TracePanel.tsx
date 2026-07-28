/**
 * Live Zephyr CTF Trace panel — Schedule Gantt + Message Queues.
 *
 * Schedule: thread lanes coloured by run / ready / blocked / sleep / suspended,
 * with a shared live-follow time window (pan / zoom / pinch).
 * Message Queues: per-msgq flow graph + depth from put/put_front/get exits.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type PointerEventHandler,
  type TouchEventHandler,
  type WheelEventHandler,
} from 'react'
import { Activity, Crosshair, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { QueuesView, QUEUES_LABEL_W } from '@/components/QueuesView'
import { NetView, NET_LABEL_W } from '@/components/NetView'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  STATE_COLOR,
  STATE_LABEL,
  contextSwitchesIn,
  fmtTime,
  renderStateRows,
  stateAt,
  threadLabel,
  threadPrio,
  threadRunningAt,
  visibleLanes,
  windowStats,
  type ThreadState,
  type Trace,
} from '@/ctf'
import {
  formatTraceTimes,
  paintCanvasTimeAxis,
  paintPlayhead,
  plotWidth,
  tsAt,
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

const LANE_H = 22
/** Room for thread name + optional prio in the left gutter. */
const LABEL_W = 96
const PAD = 8
/** Space reserved above the lanes for the time-axis ruler + labels. */
const AXIS_H = 28
/** Default live-follow window — matches a comfortable glance at the tracing sample. */
const DEFAULT_LIVE_WINDOW_NS = 4_000_000_000 // 4 s
const MIN_WINDOW_NS = 1_000_000 // 1 ms
const ZOOM_IN = 0.7
const ZOOM_OUT = 1.4
const PAN_THRESHOLD_PX = 8

type TraceTab = 'schedule' | 'queues' | 'net'

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
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const lanes = visibleLanes(tr)
  const plotRows = lanes.length + (tr.isrSpans.length ? 1 : 0)
  const cssH = Math.max(120, AXIS_H + PAD + plotRows * LANE_H + 8)
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
  const lanesTop = AXIS_H
  const layout = { labelW: LABEL_W, pad: PAD, view0, view1, t0: tr.t0 }

  paintCanvasTimeAxis(ctx, {
    cssW,
    labelW: LABEL_W,
    pad: PAD,
    view0,
    view1,
    t0: tr.t0,
    follow,
  })

  // --- Lanes -------------------------------------------------------------
  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(LABEL_W, lanesTop, plotW, lanes.length * LANE_H)

  lanes.forEach((tid, row) => {
    const y = lanesTop + row * LANE_H
    const label = threadLabel(tr, tid)
    const prio = threadPrio(tr, tid)
    const selected = selectedLane === tid
    ctx.fillStyle = selected ? 'rgba(248, 250, 252, 0.95)' : 'rgba(148, 163, 184, 0.95)'
    ctx.font = `${selected ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textBaseline = 'middle'
    const nameMax = prio != null ? 7 : 10
    const trimmed = label.length > nameMax ? `${label.slice(0, nameMax - 1)}…` : label
    ctx.fillText(trimmed, 4, y + LANE_H / 2)
    if (prio != null) {
      const prioStr = String(prio)
      ctx.fillStyle = selected ? 'rgba(148, 163, 184, 0.95)' : 'rgba(100, 116, 139, 0.95)'
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      const tw = ctx.measureText(prioStr).width
      ctx.fillText(prioStr, LABEL_W - tw - 6, y + LANE_H / 2)
    }
    if (selected) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.18)'
      ctx.fillRect(LABEL_W, y, plotW, LANE_H)
    }

    const cells = rows.get(tid) ?? []
    for (let c = 0; c < cells.length; c++) {
      const st = cells[c]
      if (!st || st === 'dead') continue
      ctx.fillStyle = STATE_COLOR[st]
      ctx.globalAlpha = st === 'run' ? 1 : 0.78
      ctx.fillRect(LABEL_W + c * colW, y + 3, Math.max(1.25, colW + 0.75), LANE_H - 6)
    }
    ctx.globalAlpha = 1
  })

  if (tr.isrSpans.length) {
    const y = lanesTop + lanes.length * LANE_H
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText('[ISR]', 4, y + LANE_H / 2)
    for (const [s, e] of tr.isrSpans) {
      if (e <= view0 || s >= view1) continue
      const x0 = LABEL_W + ((Math.max(s, view0) - view0) / span) * plotW
      const x1 = LABEL_W + ((Math.min(e, view1) - view0) / span) * plotW
      ctx.fillStyle = 'rgba(168, 85, 247, 0.8)'
      ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0), LANE_H - 6)
    }
  }

  if (playheadTs != null) {
    const x = xAt(layout, cssW, playheadTs)
    if (x >= LABEL_W && x <= LABEL_W + plotW) {
      paintPlayhead(ctx, { x, y0: AXIS_H, y1: AXIS_H + plotRows * LANE_H })
    }
  }

  canvas.style.height = `${cssH}px`
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
      kind: 'pinch'
      startDist: number
      startSpan: number
      pivot: number
      origin: { t0: number; t1: number }
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
  /** Schedule playhead — hover ts; null when not scrubbing. */
  const [playhead, setPlayhead] = useState<{ ts: number; x: number } | null>(null)
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const tab = tabIn(dock, STAGE_TRACE_KEY, TRACE_TABS, 'schedule') as TraceTab
  const setTab = (id: TraceTab) => setStoredTab(STAGE_TRACE_KEY, id)
  const followRef = useRef(follow)
  followRef.current = follow
  viewRef.current = view
  const gutterW = tab === 'queues' ? QUEUES_LABEL_W : tab === 'net' ? NET_LABEL_W : LABEL_W

  const tr = snap.trace
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
    paint(canvas, tr, view.t0, view.t1, follow, selectedLane, playhead?.ts ?? null)
  }, [tr, view, follow, snap.revision, selectedLane, tab, playhead])

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
      )
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, follow, selectedLane, tab])

  useEffect(() => {
    if (tab !== 'schedule') setPlayhead(null)
  }, [tab])

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
    const cssW = canvasRef.current?.clientWidth ?? 480
    const step = windowTimeStep(view.t0, view.t1, plotWidth(cssW, LABEL_W, PAD))
    const { rel, guest } = formatTraceTimes(playhead.ts, tr.t0, step)
    const runLabel = runningTid != null ? threadLabel(tr, runningTid) : '(idle)'
    // Absolute CTF ns from timing_ns_get — not k_uptime_ticks (no tick rate in stream).
    return [`${rel} · ${runLabel}`, `guest ${guest}`]
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
    if (g && g.kind === 'pan' && g.pointerId === e.pointerId && tr) {
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
      return
    }
  }

  const onPointerUp: PointerEventHandler<TraceSurface> = (e) => {
    const g = gestureRef.current
    if (!g || g.kind !== 'pan' || g.pointerId !== e.pointerId) return
    gestureRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (g.moved || !view || !tr || tab !== 'schedule') return
    // Tap on a lane label selects it and opens Debug → Threads.
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (x < LABEL_W && y >= AXIS_H) {
      const row = Math.floor((y - AXIS_H) / LANE_H)
      const order = visibleLanes(tr)
      if (row >= 0 && row < order.length) selectLane(order[row]!)
    }
  }

  const onPointerCancel = () => {
    gestureRef.current = null
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

  return (
    <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
      <div className="flex gap-0.5 px-0.5">
        {(
          [
            ['schedule', 'Schedule'],
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

      <div className="flex items-center gap-1 px-0.5">
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="size-9 touch-manipulation"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => applyZoom(ZOOM_IN)}
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="size-9 touch-manipulation"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => applyZoom(ZOOM_OUT)}
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="size-9 touch-manipulation"
          title="Fit entire trace"
          aria-label="Fit entire trace"
          onClick={fitAll}
        >
          <Maximize2 className="size-4" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 min-w-9 touch-manipulation px-2.5 font-mono text-xs"
            title="Pan earlier"
            aria-label="Pan earlier"
            onClick={() => panByFraction(-0.6)}
          >
            ‹
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-9 min-w-9 touch-manipulation px-2.5 font-mono text-xs"
            title="Pan later"
            aria-label="Pan later"
            onClick={() => panByFraction(0.6)}
          >
            ›
          </Button>
        </div>
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
        />
      ) : tab === 'net' && view ? (
        <NetView
          tr={tr}
          view0={view.t0}
          view1={view.t1}
          follow={follow}
          eventCount={snap.revision}
          canvasRef={netCanvasRef}
          canvasProps={canvasHandlers}
        />
      ) : (
        <>
          <div className="relative w-full select-none">
            <canvas
              ref={canvasRef}
              className="w-full cursor-crosshair touch-none select-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
              {...canvasHandlers}
              onPointerMove={(e) => {
                canvasHandlers.onPointerMove(e)
                if (!view || !tr || e.buttons !== 0) {
                  if (playheadRef.current) setPlayhead(null)
                  return
                }
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                if (x < LABEL_W || x > e.currentTarget.clientWidth - PAD) {
                  setPlayhead(null)
                  return
                }
                const ts = tsAt(
                  { labelW: LABEL_W, pad: PAD, view0: view.t0, view1: view.t1, t0: tr.t0 },
                  e.currentTarget.clientWidth,
                  x,
                )
                setPlayhead({ ts, x })
              }}
              onPointerLeave={() => setPlayhead(null)}
            />
            {scheduleTip && playhead && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 select-none rounded border border-border/70 bg-background/95 px-2 py-1 font-mono text-[10px] leading-snug text-foreground shadow-md backdrop-blur-sm"
                style={{
                  left: playhead.x > LABEL_W + 160 ? playhead.x - 10 : playhead.x + 10,
                  top: AXIS_H + 4,
                  transform: playhead.x > LABEL_W + 160 ? 'translateX(-100%)' : undefined,
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

          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
            Hover for playhead · drag to pan · pinch or ± to zoom (keeps LIVE) · tap a lane name to
            select
          </p>

          {/* Colour legend — same states as the terminal viewer. */}
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
