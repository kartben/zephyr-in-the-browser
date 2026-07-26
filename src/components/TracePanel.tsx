import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Activity, Crosshair, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  STATE_COLOR,
  STATE_LABEL,
  contextSwitchesIn,
  fmtTime,
  laneOrder,
  niceTimeStep,
  renderStateRows,
  stateAt,
  threadLabel,
  threadRunningAt,
  windowStats,
  type ThreadState,
  type Trace,
} from '@/ctf'
import { getSnapshot, subscribe } from '@/hostTrace'
import {
  STAGE_TRACE_KEY,
  effectiveExpandedIn,
  getState,
  setExpanded,
  subscribe as subscribeDock,
} from '@/lib/dockStore'

const LANE_H = 22
const LABEL_W = 72
const PAD = 8
const AXIS_H = 28
const DEFAULT_LIVE_WINDOW_NS = 4_000_000_000 // 4 s
const MIN_WINDOW_NS = 1_000_000 // 1 ms
const ZOOM_IN = 0.7
const ZOOM_OUT = 1.4
const PAN_THRESHOLD_PX = 8

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
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const lanes = laneOrder(tr).filter((tid) => {
    const segs = tr.states.get(tid)
    return segs && segs.some(([, , st]) => st !== 'dead')
  })
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

  const plotW = Math.max(1, cssW - LABEL_W - PAD)
  const span = Math.max(1, view1 - view0)
  const cols = Math.max(64, Math.floor(plotW))
  const rows = renderStateRows(tr, lanes, view0, view1, cols)
  const colW = plotW / cols
  const lanesTop = AXIS_H

  ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('t', 4, 12)

  const step = niceTimeStep(span, Math.max(3, Math.floor(plotW / 72)))
  const firstTick = Math.ceil(view0 / step) * step
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(LABEL_W, 18)
  ctx.lineTo(LABEL_W + plotW, 18)
  ctx.stroke()

  for (let t = firstTick; t <= view1 + step * 0.01; t += step) {
    const x = LABEL_W + ((t - view0) / span) * plotW
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = fmtTime(t - tr.t0)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  const leftLbl = fmtTime(view0 - tr.t0)
  const rightLbl = fmtTime(view1 - tr.t0)
  ctx.fillText(leftLbl, LABEL_W, 26)
  ctx.fillText(rightLbl, LABEL_W + plotW - ctx.measureText(rightLbl).width, 26)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(LABEL_W, lanesTop, plotW, lanes.length * LANE_H)

  lanes.forEach((tid, row) => {
    const y = lanesTop + row * LANE_H
    const label = threadLabel(tr, tid)
    const selected = selectedLane === tid
    ctx.fillStyle = selected ? 'rgba(248, 250, 252, 0.95)' : 'rgba(148, 163, 184, 0.95)'
    ctx.font = `${selected ? '600 ' : ''}11px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textBaseline = 'middle'
    const trimmed = label.length > 9 ? `${label.slice(0, 8)}…` : label
    ctx.fillText(trimmed, 4, y + LANE_H / 2)
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

  canvas.style.height = `${cssH}px`
}

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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const viewRef = useRef<{ t0: number; t1: number } | null>(null)
  const [follow, setFollow] = useState(true)
  const [liveWindowNs, setLiveWindowNs] = useState(DEFAULT_LIVE_WINDOW_NS)
  const [view, setView] = useState<{ t0: number; t1: number } | null>(null)
  const [selectedLane, setSelectedLane] = useState<number | null>(null)
  const followRef = useRef(follow)
  followRef.current = follow
  viewRef.current = view

  useEffect(() => {
    if (defaultExpanded) setExpanded(STAGE_TRACE_KEY, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded])

  const tr = snap.trace
  useEffect(() => {
    if (!tr || tr.events.length === 0) return
    if (follow) {
      setView(livePinnedView(tr, liveWindowNs))
    }
  }, [tr, follow, liveWindowNs, snap.eventCount])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !tr || !view) return
    paint(canvas, tr, view.t0, view.t1, follow, selectedLane)
  }, [tr, view, follow, snap.eventCount, selectedLane])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!tr || !viewRef.current) return
      paint(canvas, tr, viewRef.current.t0, viewRef.current.t1, follow, selectedLane)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, follow, selectedLane])

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
  }, [tr])

  const jumpLive = useCallback(() => {
    if (view) setLiveWindowNs(view.t1 - view.t0)
    setFollow(true)
  }, [view])

  const panByFraction = useCallback(
    (frac: number) => {
      if (!tr || !view) return
      setFollow(false)
      const span = view.t1 - view.t0
      setView(clampView(tr, view.t0 + span * frac, view.t1 + span * frac))
    },
    [tr, view],
  )

  if ((!snap.available && !defaultExpanded) || dock.devices[STAGE_TRACE_KEY]?.hidden) {
    return null
  }

  const expanded = defaultExpanded || effectiveExpandedIn(dock, STAGE_TRACE_KEY, 'trace')
  const lanes = tr ? laneOrder(tr) : []
  const lane = selectedLane ?? lanes[0] ?? null
  // The info strip probes the right edge, matching LIVE without a playhead.
  const probeTs = view?.t1 ?? tr?.t1 ?? 0
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

  return (
    <PanelFrame
      id="trace"
      title="Trace"
      icon={Activity}
      defaultExpanded={expanded}
      dockedWidth={34}
      fill
      side="left"
      status={
        snap.eventCount > 0 ? (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {snap.eventCount} evt · {snap.threadCount} thr
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">waiting for CTF…</span>
        )
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={follow ? 'Following live edge' : 'Jump to live edge'}
          aria-label={follow ? 'Following live edge' : 'Jump to live edge'}
          aria-pressed={follow}
          onClick={jumpLive}
          className={cn('size-8 touch-manipulation', follow && 'text-primary')}
        >
          <Crosshair className="size-4" />
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">
        {!tr || tr.events.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            Semihosting is writing <code className="font-mono text-foreground">tracing.bin</code> into
            the emulator filesystem. The Gantt appears as soon as the first CTF records land.
          </p>
        ) : (
          <>
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

            <canvas
              ref={canvasRef}
              className="w-full cursor-grab touch-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
              onWheel={(e) => {
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
                const plotW = Math.max(1, rect.width - LABEL_W - PAD)
                const x = e.clientX - rect.left
                const frac =
                  x < LABEL_W ? 0.5 : Math.min(1, Math.max(0, (x - LABEL_W) / plotW))
                const pivot = view.t0 + frac * (view.t1 - view.t0)
                setView(zoomAround(tr, view, factor, pivot))
              }}
              onPointerDown={(e) => {
                if (!view || !tr || !e.isPrimary) return
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
              }}
              onPointerMove={(e) => {
                const g = gestureRef.current
                if (!g || g.kind !== 'pan' || g.pointerId !== e.pointerId || !tr) return
                const dx = e.clientX - g.startX
                if (!g.moved && Math.abs(dx) < PAN_THRESHOLD_PX) return
                g.moved = true
                setFollow(false)
                const plotW = Math.max(1, e.currentTarget.clientWidth - LABEL_W - PAD)
                const span = g.origin.t1 - g.origin.t0
                const dt = (-dx / plotW) * span
                setView(clampView(tr, g.origin.t0 + dt, g.origin.t1 + dt))
              }}
              onPointerUp={(e) => {
                const g = gestureRef.current
                if (!g || g.kind !== 'pan' || g.pointerId !== e.pointerId) return
                gestureRef.current = null
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                } catch {
                  /* ignore */
                }
                if (g.moved || !view || !tr) return
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                const y = e.clientY - rect.top
                if (x < LABEL_W && y >= AXIS_H) {
                  const row = Math.floor((y - AXIS_H) / LANE_H)
                  const order = laneOrder(tr)
                  if (row >= 0 && row < order.length) setSelectedLane(order[row]!)
                }
              }}
              onPointerCancel={() => {
                gestureRef.current = null
              }}
              onTouchStart={(e) => {
                if (!view || !tr || e.touches.length !== 2) return
                const a = e.touches[0]!
                const b = e.touches[1]!
                const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
                const midX = (a.clientX + b.clientX) / 2
                const rect = e.currentTarget.getBoundingClientRect()
                const plotW = Math.max(1, rect.width - LABEL_W - PAD)
                const frac = Math.min(1, Math.max(0, (midX - rect.left - LABEL_W) / plotW))
                gestureRef.current = {
                  kind: 'pinch',
                  startDist: Math.max(1, dist),
                  startSpan: view.t1 - view.t0,
                  pivot: view.t0 + frac * (view.t1 - view.t0),
                  origin: view,
                }
              }}
              onTouchMove={(e) => {
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
                  g.origin.t1 > g.origin.t0
                    ? (g.pivot - g.origin.t0) / (g.origin.t1 - g.origin.t0)
                    : 0.5
                const t0 = g.pivot - nextSpan * frac
                setView(clampView(tr, t0, t0 + nextSpan))
              }}
              onTouchEnd={(e) => {
                if (e.touches.length < 2 && gestureRef.current?.kind === 'pinch') {
                  gestureRef.current = null
                }
              }}
            />

            <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
              Drag to pan · pinch or ± to zoom (keeps LIVE) · tap a lane name to select
            </p>

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
    </PanelFrame>
  )
}
