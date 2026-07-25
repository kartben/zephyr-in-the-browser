/**
 * Live Zephyr CTF schedule view — the browser cousin of
 * scripts/tracing/trace_viewer.py. One lane per thread, coloured by
 * run/ready/blocked/sleep; follows the live edge until the user pans.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Activity, Crosshair } from 'lucide-react'
import { PanelFrame } from '@/components/PanelFrame'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  STATE_COLOR,
  STATE_LABEL,
  fmtTime,
  laneOrder,
  renderStateRows,
  stateAt,
  threadLabel,
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

const LANE_H = 18
const LABEL_W = 88
const PAD = 8

function paint(
  canvas: HTMLCanvasElement,
  tr: Trace,
  view0: number,
  view1: number,
  playhead: number,
  follow: boolean,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const lanes = laneOrder(tr).filter((tid) => {
    const segs = tr.states.get(tid)
    return segs && segs.some(([, , st]) => st !== 'dead')
  })
  const cssH = Math.max(80, PAD * 2 + (lanes.length + (tr.isrSpans.length ? 1 : 0)) * LANE_H + 28)
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const plotW = Math.max(1, cssW - LABEL_W - PAD * 2)
  const cols = Math.max(32, Math.floor(plotW))
  const rows = renderStateRows(tr, lanes, view0, view1, cols)
  const colW = plotW / cols

  // Background.
  ctx.fillStyle = 'rgba(15, 23, 42, 0.35)'
  ctx.fillRect(LABEL_W, PAD, plotW, lanes.length * LANE_H)

  lanes.forEach((tid, row) => {
    const y = PAD + row * LANE_H
    const label = threadLabel(tr, tid)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText(label.length > 12 ? `${label.slice(0, 11)}…` : label, 4, y + LANE_H / 2)

    const cells = rows.get(tid) ?? []
    for (let c = 0; c < cells.length; c++) {
      const st = cells[c]
      if (!st || st === 'dead') continue
      ctx.fillStyle = STATE_COLOR[st]
      ctx.globalAlpha = st === 'run' ? 0.95 : 0.7
      ctx.fillRect(LABEL_W + c * colW, y + 2, Math.max(1, colW + 0.5), LANE_H - 4)
    }
    ctx.globalAlpha = 1
  })

  // ISR overlay lane.
  if (tr.isrSpans.length) {
    const y = PAD + lanes.length * LANE_H
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.fillText('[ISR]', 4, y + LANE_H / 2)
    const span = Math.max(1, view1 - view0)
    for (const [s, e] of tr.isrSpans) {
      if (e <= view0 || s >= view1) continue
      const x0 = LABEL_W + ((Math.max(s, view0) - view0) / span) * plotW
      const x1 = LABEL_W + ((Math.min(e, view1) - view0) / span) * plotW
      ctx.fillStyle = 'rgba(168, 85, 247, 0.75)'
      ctx.fillRect(x0, y + 2, Math.max(1, x1 - x0), LANE_H - 4)
    }
  }

  // Playhead.
  if (playhead >= view0 && playhead <= view1) {
    const span = Math.max(1, view1 - view0)
    const x = LABEL_W + ((playhead - view0) / span) * plotW
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, PAD)
    ctx.lineTo(x, PAD + (lanes.length + (tr.isrSpans.length ? 1 : 0)) * LANE_H)
    ctx.stroke()
  }

  // Axis.
  const axisY = PAD + (lanes.length + (tr.isrSpans.length ? 1 : 0)) * LANE_H + 4
  ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(fmtTime(0), LABEL_W, axisY + 12)
  const endLabel = fmtTime(view1 - view0)
  ctx.fillText(endLabel, LABEL_W + plotW - ctx.measureText(endLabel).width, axisY + 12)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.9)'
    ctx.fillText('LIVE', cssW - 36, axisY + 12)
  }

  canvas.style.height = `${cssH}px`
}

export function TracePanel({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const dock = useSyncExternalStore(subscribeDock, getState, getState)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [follow, setFollow] = useState(true)
  const [view, setView] = useState<{ t0: number; t1: number } | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [selectedLane, setSelectedLane] = useState<number | null>(null)

  // Seed expansion from the sample once; the dock store owns the override.
  useEffect(() => {
    if (defaultExpanded) setExpanded(STAGE_TRACE_KEY, true)
    // Only on mount / sample-driven default change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultExpanded])

  const tr = snap.trace
  useEffect(() => {
    if (!tr || tr.events.length === 0) return
    if (follow) {
      const span = Math.max(tr.t1 - tr.t0, 1_000_000) // at least 1 ms window
      const windowNs = Math.min(span, 20_000_000) // 20 ms default live window
      const t1 = tr.t1
      const t0 = Math.max(tr.t0, t1 - windowNs)
      setView({ t0, t1 })
      setPlayhead(t1)
    }
  }, [tr, follow, snap.eventCount])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !tr || !view) return
    paint(canvas, tr, view.t0, view.t1, playhead, follow)
  }, [tr, view, playhead, follow, snap.eventCount])

  // Show for the Tracing sample immediately (waiting state), and for any other
  // sample once semihosting has created tracing.bin.
  if ((!snap.available && !defaultExpanded) || dock.devices[STAGE_TRACE_KEY]?.hidden) {
    return null
  }

  // Prefer the sample-driven prop for PanelFrame's initial open state — the dock
  // seed lands in a useEffect one tick later, which would otherwise leave the
  // Tracing sample's panel collapsed on first paint.
  const expanded = defaultExpanded || effectiveExpandedIn(dock, STAGE_TRACE_KEY, 'trace')
  const lanes = tr ? laneOrder(tr) : []
  const lane = selectedLane ?? lanes[0] ?? null
  const [st, reason] =
    tr && lane !== null ? stateAt(tr, lane, playhead) : ([null, ''] as [ThreadState | null, string])

  return (
    <PanelFrame
      id="trace"
      title="Trace"
      icon={Activity}
      defaultExpanded={expanded}
      dockedWidth={28}
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
          title={follow ? 'Following live edge' : 'Re-sync to live edge'}
          aria-pressed={follow}
          onClick={() => setFollow(true)}
          className={cn('size-6', follow && 'text-primary')}
        >
          <Crosshair className="size-3.5" />
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
            <canvas
              ref={canvasRef}
              className="w-full cursor-crosshair rounded border border-border/60 bg-slate-950/40"
              onWheel={(e) => {
                if (!view || !tr) return
                e.preventDefault()
                setFollow(false)
                const span = view.t1 - view.t0
                const factor = e.deltaY > 0 ? 1.25 : 0.8
                const mid = playhead
                const nextSpan = Math.max(1000, Math.min(tr.t1 - tr.t0, span * factor))
                let t0 = mid - nextSpan / 2
                let t1 = mid + nextSpan / 2
                if (t0 < tr.t0) {
                  t0 = tr.t0
                  t1 = t0 + nextSpan
                }
                if (t1 > tr.t1) {
                  t1 = tr.t1
                  t0 = Math.max(tr.t0, t1 - nextSpan)
                }
                setView({ t0, t1 })
              }}
              onClick={(e) => {
                if (!view || !tr) return
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                if (x < LABEL_W) {
                  const row = Math.floor((e.clientY - rect.top - PAD) / LANE_H)
                  const order = laneOrder(tr)
                  if (row >= 0 && row < order.length) setSelectedLane(order[row]!)
                  return
                }
                setFollow(false)
                const plotW = rect.width - LABEL_W - PAD * 2
                const frac = Math.min(1, Math.max(0, (x - LABEL_W) / plotW))
                setPlayhead(view.t0 + frac * (view.t1 - view.t0))
              }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
              {(Object.keys(STATE_LABEL) as ThreadState[])
                .filter((s) => s !== 'dead')
                .map((s) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <span
                      className="inline-block size-2 rounded-sm"
                      style={{ background: STATE_COLOR[s] }}
                    />
                    {STATE_LABEL[s]}
                  </span>
                ))}
            </div>
            <div className="rounded border border-border/50 bg-muted/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
              <span className="text-foreground">{fmtTime(playhead - (tr.t0 || 0))}</span>
              {lane !== null && (
                <>
                  {' · '}
                  <span className="text-foreground">{threadLabel(tr, lane)}</span>
                  {st && (
                    <>
                      {' · '}
                      <span style={{ color: STATE_COLOR[st] }}>{STATE_LABEL[st]}</span>
                      {reason ? ` (${reason})` : ''}
                    </>
                  )}
                </>
              )}
              {snap.desync && (
                <span className="ml-2 text-amber-500">desync — unknown CTF id</span>
              )}
            </div>
          </>
        )}
      </div>
    </PanelFrame>
  )
}
