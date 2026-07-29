/**
 * CPU residency + host peripheral activity — shares the Trace time window.
 * See docs/trace-power-plan.md.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CanvasHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { cn } from '@/lib/utils'
import { applyYZoomTransform, type YZoom } from '@/components/traceChart'
import {
  dutyBuckets,
  formatPct,
  formatResidencyDuration,
  reconstructCpuResidency,
  residencyWindowStats,
  type CpuResidency,
  type Trace,
  fmtTime,
  niceTimeStep,
} from '@/ctf'
import {
  collectPeripheralMarks,
  peripheralWindowStats,
  reconstructPeripheralLanes,
  type PeripheralLane,
} from '@/power/peripheralActivity'
import { i2cModel, spiModel } from '@/virtio'

const LABEL_W = 108
const PAD = 8
const AXIS_H = 28
const LANE_H = 52
const PERIPH_ROW_H = 28
const STRIP_H = 44
const STRIP_GAP = 8
const MAX_PERIPH_LANES = 6

const COL_ACTIVE = 'rgba(245, 158, 11, 0.82)'
const COL_ACTIVE_TOP = 'rgba(251, 191, 36, 0.95)'
const COL_IDLE = 'rgba(100, 116, 139, 0.42)'
const COL_WAKE = 'rgba(52, 211, 153, 0.95)'
const COL_DUTY = 'rgba(56, 189, 248, 0.85)'
const COL_I2C = 'rgba(56, 189, 248, 0.92)'
const COL_SPI = 'rgba(251, 146, 60, 0.92)'
const COL_GPIO = 'rgba(45, 212, 191, 0.9)'
const COL_ERR = 'rgba(248, 113, 113, 0.95)'

function busColor(bus: PeripheralLane['bus']): string {
  if (bus === 'i2c') return COL_I2C
  if (bus === 'spi') return COL_SPI
  return COL_GPIO
}

function paint(
  canvas: HTMLCanvasElement,
  res: CpuResidency,
  periphLanes: PeripheralLane[],
  view0: number,
  view1: number,
  follow: boolean,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const periphH = periphLanes.length > 0 ? 18 + periphLanes.length * PERIPH_ROW_H : 28
  const cssH = Math.max(
    160,
    AXIS_H + LANE_H + STRIP_GAP + periphH + STRIP_GAP + STRIP_H + 8,
  )
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
  const xAt = (t: number) => LABEL_W + ((t - view0) / span) * plotW

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
    const x = xAt(t)
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = fmtTime(t)
    const tw = ctx.measureText(label).width
    let lx = x - tw / 2
    lx = Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, lx))
    ctx.fillText(label, lx, 12)
  }

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  ctx.fillText(fmtTime(view0), LABEL_W, 26)
  const rightLbl = fmtTime(view1)
  ctx.fillText(rightLbl, LABEL_W + plotW - ctx.measureText(rightLbl).width, 26)
  if (follow) {
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  const laneTop = AXIS_H + 4
  const laneBottom = AXIS_H + LANE_H - 4
  const laneMid = (laneTop + laneBottom) / 2

  ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText('CPU', 10, laneMid - 4)
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('residency', 10, laneMid + 10)

  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)'
  ctx.fillRect(LABEL_W, laneTop, plotW, laneBottom - laneTop)

  if (res.segments.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('Waiting for schedule CTF…', LABEL_W + 6, laneMid + 4)
  } else {
    for (const seg of res.segments) {
      if (seg.end <= view0 || seg.start >= view1) continue
      const x0 = Math.max(LABEL_W, xAt(seg.start))
      const x1 = Math.min(LABEL_W + plotW, xAt(seg.end))
      const w = Math.max(1, x1 - x0)
      if (seg.mode === 'active') {
        const g = ctx.createLinearGradient(0, laneTop, 0, laneBottom)
        g.addColorStop(0, COL_ACTIVE_TOP)
        g.addColorStop(1, COL_ACTIVE)
        ctx.fillStyle = g
      } else {
        ctx.fillStyle = COL_IDLE
      }
      ctx.fillRect(x0, laneTop, w, laneBottom - laneTop)
    }
    for (const wake of res.wakes) {
      if (wake.ts < view0 || wake.ts > view1) continue
      const x = xAt(wake.ts)
      if (x < LABEL_W || x > LABEL_W + plotW) continue
      ctx.strokeStyle = COL_WAKE
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, laneTop - 6)
      ctx.lineTo(x, laneBottom)
      ctx.stroke()
      ctx.fillStyle = COL_WAKE
      ctx.beginPath()
      ctx.arc(x, laneTop - 6, 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Peripheral lanes
  const periphTop = AXIS_H + LANE_H + STRIP_GAP
  ctx.strokeStyle = 'rgba(42, 51, 66, 0.95)'
  ctx.beginPath()
  ctx.moveTo(8, periphTop - 4)
  ctx.lineTo(cssW - 8, periphTop - 4)
  ctx.stroke()

  ctx.fillStyle = 'rgba(106, 115, 130, 0.95)'
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('PERIPHERALS · HOST BUS / GPIO (APPROX)', 10, periphTop + 10)

  if (periphLanes.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(
      follow
        ? 'No I²C / SPI / GPIO activity in this window yet.'
        : 'Peripheral marks need Live follow (host↔guest clock is approximate).',
      LABEL_W,
      periphTop + 28,
    )
  } else {
    periphLanes.forEach((lane, i) => {
      const y = periphTop + 16 + i * PERIPH_ROW_H
      const rowMid = y + PERIPH_ROW_H / 2
      ctx.fillStyle = 'rgba(15, 23, 42, 0.4)'
      ctx.fillRect(LABEL_W, y + 4, plotW, PERIPH_ROW_H - 8)

      ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(lane.label, 10, rowMid - 2)
      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
      ctx.font = '9px ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(lane.sub, 10, rowMid + 10)

      const color = busColor(lane.bus)
      for (const m of lane.marks) {
        const x = xAt(m.ts)
        if (x < LABEL_W || x > LABEL_W + plotW) continue
        const h = Math.max(8, Math.min(18, 6 + (m.bytes ?? 2)))
        ctx.fillStyle = m.ok ? color : COL_ERR
        ctx.globalAlpha = 0.9
        ctx.fillRect(x - 1.5, rowMid - h / 2, 3, h)
      }
      ctx.globalAlpha = 1
    })
  }

  // Duty strip
  const stripTop =
    periphTop + (periphLanes.length > 0 ? 16 + periphLanes.length * PERIPH_ROW_H : 36) + 4
  const stripBottom = stripTop + STRIP_H - 6
  ctx.strokeStyle = 'rgba(42, 51, 66, 0.95)'
  ctx.beginPath()
  ctx.moveTo(8, stripTop - 2)
  ctx.lineTo(cssW - 8, stripTop - 2)
  ctx.stroke()

  ctx.fillStyle = 'rgba(106, 115, 130, 0.95)'
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'
  ctx.fillText('DUTY · BUCKETED BUSY %', 10, stripTop + 10)

  const bucketCount = Math.max(24, Math.min(64, Math.floor(plotW / 10)))
  const buckets = dutyBuckets(res, view0, view1, bucketCount)
  const bw = plotW / buckets.length
  const barH = Math.max(8, stripBottom - (stripTop + 14))
  for (let i = 0; i < buckets.length; i++) {
    const frac = buckets[i]!
    const h = Math.max(frac > 0 ? 2 : 0, frac * barH)
    ctx.fillStyle = COL_DUTY
    ctx.globalAlpha = 0.35 + frac * 0.65
    ctx.fillRect(LABEL_W + i * bw + 1, stripBottom - h, Math.max(1, bw - 2), h)
  }
  ctx.globalAlpha = 1

  canvas.style.height = `${cssH}px`
}

function subscribeBus(fn: () => void) {
  const u1 = i2cModel.subscribe(fn)
  const u2 = spiModel.subscribe(fn)
  return () => {
    u1()
    u2()
  }
}

function busRevision() {
  return i2cModel.transactionCount() * 1_000_003 + spiModel.transactionCount()
}

export function PowerView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  canvasRef,
  canvasProps,
  overlay,
  boxZoomArmed = false,
  yZoom = null,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
  overlay?: ReactNode
  boxZoomArmed?: boolean
  yZoom?: YZoom | null
}) {
  const busRev = useSyncExternalStore(subscribeBus, busRevision, () => 0)
  const residency = useMemo(
    () => reconstructCpuResidency(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const stats = useMemo(
    () => residencyWindowStats(residency, view0, view1),
    [residency, view0, view1],
  )
  const periphLanes = useMemo(() => {
    const marks = collectPeripheralMarks()
    const lanes = reconstructPeripheralLanes(marks, view0, view1)
    return lanes.slice(0, MAX_PERIPH_LANES)
    // busRev + eventCount refresh host marks against the live CTF anchor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view0, view1, eventCount, busRev, follow])
  const periphStats = useMemo(() => peripheralWindowStats(periphLanes), [periphLanes])

  const resRef = useRef(residency)
  const lanesRef = useRef(periphLanes)
  const yZoomRef = useRef(yZoom)
  resRef.current = residency
  lanesRef.current = periphLanes
  yZoomRef.current = yZoom

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, residency, periphLanes, view0, view1, follow, yZoom)
  }, [residency, periphLanes, view0, view1, follow, canvasRef, yZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(
        canvas,
        resRef.current,
        lanesRef.current,
        view0,
        view1,
        follow,
        yZoomRef.current,
      )
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [view0, view1, follow, canvasRef])

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span>
          busy <span className="font-mono text-amber-400/90">{formatPct(stats.busyPct)}</span>
        </span>
        <span>
          idle <span className="font-mono text-slate-300/90">{formatPct(stats.idlePct)}</span>
        </span>
        <span>
          wakes <span className="font-mono text-emerald-400/90">{stats.wakeCount}</span>
        </span>
        <span>
          mean idle{' '}
          <span className="font-mono text-foreground">
            {formatResidencyDuration(stats.meanIdleNs)}
          </span>
        </span>
        <span>
          peri{' '}
          <span className="font-mono text-sky-400/90">
            {periphStats.marks}
          </span>
          <span className="text-muted-foreground/80">
            {' '}
            ({periphStats.buses.i2c} i2c · {periphStats.buses.spi} spi · {periphStats.buses.gpio}{' '}
            gpio)
          </span>
        </span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-amber-400" />
            cpu
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-sky-400" />
            i2c
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-orange-400" />
            spi
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-teal-400" />
            gpio
          </span>
        </span>
      </div>
      <div className="relative w-full select-none">
        <canvas
          ref={canvasRef}
          className={cn(
            'w-full touch-none select-none rounded border border-border/60 bg-slate-950/40',
            boxZoomArmed ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
          )}
          {...canvasProps}
        />
        {overlay}
      </div>
    </>
  )
}

export const POWER_LABEL_W = LABEL_W
