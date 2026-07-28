/**
 * Socket swimlanes + net-core latency strip — shares the Trace time window.
 */

import { useEffect, useMemo, useRef, type CanvasHTMLAttributes, type RefObject } from 'react'
import {
  formatByteCount,
  fmtTime,
  niceTimeStep,
  reconstructNetCore,
  reconstructSockets,
  socketLabel,
  socketWindowStats,
  type NetCoreSeries,
  type SocketSeries,
  type Trace,
} from '@/ctf'

const LABEL_W = 148
const PAD = 8
const AXIS_H = 28
const ROW_H = 44
const STRIP_H = 56
const MARK_MAX_H = 22

const COL_TX = 'rgba(52, 211, 153, 0.9)'
const COL_RX = 'rgba(96, 165, 250, 0.9)'
const COL_ERR = 'rgba(248, 113, 113, 0.95)'
const COL_LISTEN = 'rgba(167, 139, 250, 0.55)'

function paint(
  canvas: HTMLCanvasElement,
  tr: Trace,
  sockets: SocketSeries[],
  net: NetCoreSeries[],
  view0: number,
  view1: number,
  follow: boolean,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const rows = Math.max(1, sockets.length)
  const showStrip = net.some((n) => n.samples.length > 0)
  const cssH = Math.max(120, AXIS_H + rows * ROW_H + (showStrip ? STRIP_H : 0) + 8)
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

  if (sockets.length === 0) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)'
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No socket CTF events in this window yet.', LABEL_W, AXIS_H + 28)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.9)'
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(
      'Needs CONFIG_TRACING_NET_SOCKETS (on by default for net samples like zperf).',
      LABEL_W,
      AXIS_H + 48,
    )
    canvas.style.height = `${cssH}px`
    return
  }

  // Peak bytes in view for mark height scaling.
  let peakBytes = 1
  for (const s of sockets) {
    for (const sample of s.samples) {
      if (sample.ts < view0 || sample.ts > view1) continue
      if ((sample.op === 'send' || sample.op === 'recv') && sample.bytes > peakBytes) {
        peakBytes = sample.bytes
      }
    }
  }

  sockets.forEach((s, row) => {
    const y0 = AXIS_H + row * ROW_H
    const mid = y0 + ROW_H / 2

    ctx.fillStyle = row % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.2)'
    ctx.fillRect(0, y0, cssW, ROW_H)

    const label = socketLabel(s)
    ctx.fillStyle = 'rgba(226, 232, 240, 0.95)'
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    const line1 = label.length > 22 ? `${label.slice(0, 21)}…` : label
    ctx.fillText(line1, 4, mid - 6)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)'
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.fillText(
      `↑${formatByteCount(s.txBytes)} ↓${formatByteCount(s.rxBytes)}`,
      4,
      mid + 8,
    )

    // Listening band across open interval.
    if (s.socket.state === 'listening' || s.samples.some((x) => x.op === 'listen' && x.ok)) {
      const x0 = LABEL_W + ((Math.max(s.firstTs, view0) - view0) / span) * plotW
      const x1 = LABEL_W + ((Math.min(s.lastTs, view1) - view0) / span) * plotW
      if (x1 > x0) {
        ctx.fillStyle = COL_LISTEN
        ctx.fillRect(x0, mid - 4, Math.max(1, x1 - x0), 8)
      }
    }

    for (const sample of s.samples) {
      if (sample.ts < view0 || sample.ts > view1) continue
      const x = LABEL_W + ((sample.ts - view0) / span) * plotW
      if (sample.op === 'send' || sample.op === 'recv') {
        const h = Math.max(
          3,
          Math.round((sample.bytes / peakBytes) * MARK_MAX_H) || 3,
        )
        ctx.fillStyle = !sample.ok ? COL_ERR : sample.op === 'send' ? COL_TX : COL_RX
        ctx.fillRect(x - 1.5, mid - h / 2, 3, h)
      } else if (sample.op === 'accept' && sample.ok) {
        ctx.fillStyle = COL_LISTEN
        ctx.fillRect(x - 1, mid - 8, 2, 16)
      } else if (sample.op === 'connect' || sample.op === 'bind' || sample.op === 'init') {
        ctx.fillStyle = sample.ok ? 'rgba(226, 232, 240, 0.7)' : COL_ERR
        ctx.beginPath()
        ctx.arc(x, mid, 2.2, 0, Math.PI * 2)
        ctx.fill()
      } else if (sample.op === 'close') {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)'
        ctx.beginPath()
        ctx.moveTo(x, mid - 8)
        ctx.lineTo(x, mid + 8)
        ctx.stroke()
      }
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)'
    ctx.beginPath()
    ctx.moveTo(LABEL_W, y0 + ROW_H - 0.5)
    ctx.lineTo(LABEL_W + plotW, y0 + ROW_H - 0.5)
    ctx.stroke()
  })

  if (showStrip) {
    const y0 = AXIS_H + sockets.length * ROW_H
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
    ctx.fillRect(0, y0, cssW, STRIP_H)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.95)'
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText('net_rx / net_tx µs', 4, y0 + 12)

    let maxUs = 1
    for (const n of net) {
      for (const sample of n.samples) {
        if (sample.durationUs > maxUs) maxUs = sample.durationUs
      }
    }
    const plotTop = y0 + 18
    const plotH = STRIP_H - 24

    for (const n of net) {
      const timed = n.samples.filter((s) => s.durationUs > 0)
      if (timed.length === 0) continue
      for (const dir of ['rx', 'tx'] as const) {
        const pts = timed.filter((s) => s.dir === dir)
        if (pts.length === 0) continue
        ctx.strokeStyle = dir === 'rx' ? COL_RX : COL_TX
        ctx.lineWidth = 1.25
        ctx.beginPath()
        let started = false
        for (const sample of pts) {
          if (sample.ts < view0 || sample.ts > view1) continue
          const x = LABEL_W + ((sample.ts - view0) / span) * plotW
          const y = plotTop + (1 - sample.durationUs / maxUs) * plotH
          if (!started) {
            ctx.moveTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        if (started) ctx.stroke()
      }
    }
  }

  canvas.style.height = `${cssH}px`
}

export function NetView({
  tr,
  view0,
  view1,
  follow,
  eventCount,
  canvasRef,
  canvasProps,
}: {
  tr: Trace
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
}) {
  const sockets = useMemo(
    () => reconstructSockets(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const net = useMemo(
    () => reconstructNetCore(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const stats = useMemo(
    () => socketWindowStats(sockets, view0, view1),
    [sockets, view0, view1],
  )
  const socketsRef = useRef(sockets)
  const netRef = useRef(net)
  socketsRef.current = sockets
  netRef.current = net

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, tr, sockets, net, view0, view1, follow)
  }, [tr, sockets, net, view0, view1, follow, canvasRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      paint(canvas, tr, socketsRef.current, netRef.current, view0, view1, follow)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, view0, view1, follow, canvasRef])

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span>
          sockets <span className="font-mono text-foreground">{stats.sockets}</span>
        </span>
        <span>
          tx{' '}
          <span className="font-mono text-emerald-400/90">{formatByteCount(stats.txBytes)}</span>
        </span>
        <span>
          rx <span className="font-mono text-sky-400/90">{formatByteCount(stats.rxBytes)}</span>
        </span>
        <span>
          err <span className="font-mono text-rose-400/90">{stats.errors}</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-emerald-400" />
            send
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-sky-400" />
            recv
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-1.5 rounded-sm bg-rose-400" />
            err
          </span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full cursor-grab touch-none rounded border border-border/60 bg-slate-950/40 active:cursor-grabbing"
        {...canvasProps}
      />
    </>
  )
}

/** Hit-test / pan gutter — TracePanel must use the same width. */
export const NET_LABEL_W = LABEL_W
