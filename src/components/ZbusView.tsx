/**
 * Trace → zbus: channel lanes, with each observer's part under its channel.
 *
 * A channel row holds the calls made on it: each publish as a bar from entry to
 * return, labelled with the thread that made it, and reads and claims thinner
 * under it. Under the channel, one row per observer, in the order the
 * dispatcher tells them, shows what that told it and what came of it:
 *
 * - a listener's block is its callback, run inside the publish;
 * - a subscriber's block is the put into its queue, then a dot where its thread
 *   woke with the channel, then that thread's read of the message;
 * - an async listener's block is the hand-off to its work queue, then its
 *   callback where the work queue ran it.
 *
 * Channels and observers come from the image (debug/elfZbus.ts), so a channel
 * nobody publishes still has its row, and the observers sit in dispatch order
 * before the first event arrives. Shares the Trace window, gestures and box
 * zoom, like the Networking and Power tabs. Hovering anything gives a two-line
 * tip, worked out from the same placements paint draws (zbusChart.ts).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CanvasHTMLAttributes,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  applyYZoomTransform,
  baseYToScreen,
  screenYToBase,
  type YZoom,
} from '@/components/traceChart'
import { useTraceInk, type TraceInk } from '@/components/traceInk'
import {
  AXIS_H,
  DOT_R,
  LABEL_W,
  buildRows,
  placedBox,
  placeRows,
  rowHeight,
  zbusHitTest,
  zbusTip,
  type Placed,
  type Row,
  type ZbusXScale,
} from '@/components/zbusChart'
import {
  fmtTime,
  hasZbusEvents,
  niceTimeStep,
  reconstructZbus,
  threadLabel,
  zbusErrno,
  zbusWindowStats,
  type Trace,
} from '@/ctf'
import { type ZbusObserverKind, type ZbusTopology } from '@/debug/elfZbus'
import { cn } from '@/lib/utils'

const PAD = 8
/** The note an image without the hooks gets above its rows. */
const NOTE_H = 40

const COL_PUB = 'rgba(52, 211, 153, 0.8)'
const COL_READ = 'rgba(148, 163, 184, 0.75)'
const COL_CLAIM = 'rgba(251, 191, 36, 0.35)'
const COL_ERR = 'rgba(248, 113, 113, 0.95)'

/** Short enough to sit beside an observer's name in the gutter. */
const KIND_TAG: Record<ZbusObserverKind | 'unknown', string> = {
  listener: 'listener',
  subscriber: 'subscriber',
  msg_subscriber: 'msg sub',
  async_listener: 'async',
  unknown: 'observer',
}

const KIND_COLOR: Record<ZbusObserverKind | 'unknown', string> = {
  listener: 'rgba(251, 191, 36, 0.9)',
  subscriber: 'rgba(96, 165, 250, 0.9)',
  msg_subscriber: 'rgba(45, 212, 191, 0.9)',
  async_listener: 'rgba(167, 139, 250, 0.9)',
  unknown: 'rgba(148, 163, 184, 0.9)',
}

function paint(
  canvas: HTMLCanvasElement,
  ink: TraceInk,
  tr: Trace,
  rows: Row[],
  items: Placed[][],
  hasEvents: boolean,
  view0: number,
  view1: number,
  follow: boolean,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const body = rows.reduce((h, r) => h + rowHeight(r), 0)
  const note = hasEvents ? 0 : NOTE_H
  const cssH = Math.max(120, AXIS_H + note + body + 8)
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
  const X = (t: number) => LABEL_W + ((t - view0) / span) * plotW
  const clampX = (x: number) => Math.max(LABEL_W, Math.min(LABEL_W + plotW, x))
  const end = (t: number | null) => t ?? Math.max(view1, tr.t1)
  const muted = ink.label(0.85)

  // Axis, as the other Trace tabs draw it.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  const step = niceTimeStep(span, Math.max(3, Math.floor(plotW / 72)))
  ctx.strokeStyle = ink.label(0.45)
  ctx.fillStyle = ink.label(0.9)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(LABEL_W, 18)
  ctx.lineTo(LABEL_W + plotW, 18)
  ctx.stroke()
  for (let t = Math.ceil(view0 / step) * step; t <= view1 + step * 0.01; t += step) {
    const x = X(t)
    if (x < LABEL_W - 0.5 || x > LABEL_W + plotW + 0.5) continue
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, 22)
    ctx.stroke()
    const label = fmtTime(t)
    const tw = ctx.measureText(label).width
    ctx.fillText(label, Math.max(LABEL_W, Math.min(LABEL_W + plotW - tw, x - tw / 2)), 12)
  }
  if (follow) {
    ctx.fillStyle = ink.live(0.95)
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  if (!hasEvents) {
    ctx.fillStyle = muted
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No zbus events in this trace. The channels and observers come from the image.', 8, AXIS_H + 16)
    ctx.fillStyle = ink.dim(0.95)
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText(
      'Publishes and notifications need the zbus trace hooks (CONFIG_TRACING_ZBUS), which upstream Zephyr does not have yet.',
      8,
      AXIS_H + 32,
    )
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, AXIS_H, cssW, Math.max(1, cssH - AXIS_H))
  ctx.clip()
  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  /**
   * A bar with an optional label inside, when it fits both ways. An `outside`
   * label that does not fit goes beside the bar instead, in the bar's colour:
   * a rejected publish lasts microseconds, and the reason is the point.
   */
  const bar = (
    t0: number,
    t1: number,
    y: number,
    h: number,
    fill: string,
    label?: string,
    outside = false,
  ) => {
    if (t1 < view0 || t0 > view1) return
    const x0 = clampX(X(t0))
    const x1 = clampX(X(t1))
    const w = Math.max(2, x1 - x0)
    ctx.fillStyle = fill
    ctx.fillRect(x0, y, w, h)
    if (!label || h < 10) return
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    if (w > tw + 8) {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.9)'
      ctx.fillText(label, x0 + 4, y + h / 2 + 0.5)
    } else if (outside) {
      ctx.fillStyle = fill
      const right = x0 + w + 4
      ctx.fillText(label, right + tw <= LABEL_W + plotW ? right : x0 - tw - 4, y + h / 2 + 0.5)
    }
  }
  /** A dashed hand-off line along a row, from the dispatcher to the reaction. */
  const link = (ta: number, tb: number, y: number) => {
    if (tb < view0 || ta > view1 || tb <= ta) return
    ctx.strokeStyle = ink.label(0.55)
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(clampX(X(ta)), y)
    ctx.lineTo(clampX(X(tb)), y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  let y = AXIS_H + note
  rows.forEach((r, i) => {
    const h = rowHeight(r)
    ctx.fillStyle = ink.shade(r.group % 2 === 0 ? 0.35 : 0.18)
    ctx.fillRect(0, y, cssW, h)
    const mid = y + h / 2
    ctx.textBaseline = 'middle'

    if (r.kind === 'chan') {
      ctx.fillStyle = ink.text(0.95)
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label, 4, mid - 6)
      ctx.fillStyle = muted
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(r.detail, 4, mid + 7)

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const p of items[i] ?? []) {
        const it = p.item
        if (it.kind === 'held') {
          bar(p.t0, end(p.t1), y + p.top, p.height, COL_CLAIM, 'claimed')
          continue
        }
        if (it.kind !== 'call') continue
        const c = it.call
        const failed = c.ret !== null && c.ret < 0
        if (c.op === 'pub' || c.op === 'notify') {
          const who = c.thread !== null ? threadLabel(tr, c.thread) : 'ISR'
          const label = failed
            ? `${who} ${zbusErrno(c.ret!)}`
            : c.op === 'notify'
              ? `${who} · notify`
              : who
          bar(p.t0, end(p.t1), y + p.top, p.height, failed ? COL_ERR : COL_PUB, label, failed)
        } else {
          const fill = failed ? COL_ERR : c.op === 'read' ? COL_READ : COL_CLAIM
          bar(p.t0, end(p.t1), y + p.top, p.height, fill)
        }
      }
    } else {
      const color = KIND_COLOR[r.obsKind ?? 'unknown']
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillStyle = muted
      ctx.fillText(r.last ? '└' : '├', 6, mid)
      const name = r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label
      ctx.fillStyle = color
      ctx.fillText(name, 18, mid)
      ctx.fillStyle = muted
      ctx.font = '8px ui-sans-serif, system-ui, sans-serif'
      const tag = KIND_TAG[r.obsKind ?? 'unknown']
      ctx.fillText(tag, LABEL_W - ctx.measureText(tag).width - 6, mid)

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const p of items[i] ?? []) {
        const it = p.item
        if (p.from !== null) link(p.from, p.t0, mid)
        if (it.kind === 'notify') {
          const failed = it.notify.ret !== null && it.notify.ret < 0
          // A listener's notification is its callback, so it gets a name.
          const label = failed
            ? zbusErrno(it.notify.ret!)
            : r.obsKind === 'listener'
              ? 'callback'
              : undefined
          bar(p.t0, end(p.t1), y + p.top, p.height, failed ? COL_ERR : color, label)
        } else if (it.kind === 'wake') {
          if (p.t0 >= view0 && p.t0 <= view1) {
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(X(p.t0), mid, DOT_R, 0, Math.PI * 2)
            ctx.fill()
          }
        } else if (it.kind === 'read') {
          bar(p.t0, end(p.t1), y + p.top, p.height, COL_READ, `${threadLabel(tr, it.call.thread!)} · read`)
        } else if (it.kind === 'run') {
          const who = it.run.thread !== null ? threadLabel(tr, it.run.thread) : 'ISR'
          bar(p.t0, end(p.t1), y + p.top, p.height, color, who)
        }
      }
    }

    ctx.strokeStyle = ink.label(0.16)
    ctx.beginPath()
    ctx.moveTo(LABEL_W, y + h - 0.5)
    ctx.lineTo(LABEL_W + plotW, y + h - 0.5)
    ctx.stroke()
    y += h
  })

  ctx.restore()
  canvas.style.height = `${cssH}px`
}

export function ZbusView({
  tr,
  topology,
  view0,
  view1,
  follow,
  eventCount,
  canvasRef,
  canvasProps,
  overlay,
  boxZoomArmed = false,
  yZoom = null,
  toolbar,
}: {
  tr: Trace
  /** The image's channels and observers; null when it has none (or no symbols). */
  topology: ZbusTopology | null
  view0: number
  view1: number
  follow: boolean
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
  overlay?: ReactNode
  boxZoomArmed?: boolean
  yZoom?: YZoom | null
  toolbar?: ReactNode
}) {
  const activity = useMemo(
    () => reconstructZbus(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const hasEvents = useMemo(
    () => hasZbusEvents(tr),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tr, eventCount],
  )
  const rows = useMemo(() => buildRows(topology, activity), [topology, activity])
  const items = useMemo(() => placeRows(rows, activity, topology), [rows, activity, topology])
  const stats = useMemo(() => zbusWindowStats(activity, view0, view1), [activity, view0, view1])
  const latest = useRef({ rows, items, hasEvents, yZoom })
  latest.current = { rows, items, hasEvents, yZoom }
  const ink = useTraceInk()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, ink, tr, rows, items, hasEvents, view0, view1, follow, yZoom)
  }, [ink, tr, rows, items, hasEvents, view0, view1, follow, canvasRef, yZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const l = latest.current
      paint(canvas, ink, tr, l.rows, l.items, l.hasEvents, view0, view1, follow, l.yZoom)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [ink, tr, view0, view1, follow, canvasRef])

  /*
   * The pointer over the canvas, with the canvas's size then; null while it is
   * elsewhere or dragging. What it is over is worked out from the current
   * rows, so the tip follows a live trace and a zoom without the pointer moving.
   */
  const [pointer, setPointer] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const pressedAt = useRef<{ x: number; y: number } | null>(null)
  const pointAt = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const { clientWidth: w, clientHeight: h } = e.currentTarget
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w, h }
  }
  const handlers: CanvasHTMLAttributes<HTMLCanvasElement> = {
    ...canvasProps,
    onPointerDown: (e) => {
      canvasProps?.onPointerDown?.(e)
      pressedAt.current = { x: e.clientX, y: e.clientY }
      setPointer(null)
    },
    onPointerMove: (e) => {
      canvasProps?.onPointerMove?.(e)
      // A drag pans the window; the tip comes back when it ends.
      if (e.buttons === 0 && e.pointerType !== 'touch') setPointer(pointAt(e))
    },
    onPointerUp: (e) => {
      canvasProps?.onPointerUp?.(e)
      const down = pressedAt.current
      pressedAt.current = null
      // A touch screen has no hover: a tap shows the tip instead.
      const tap = down !== null && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6
      if (e.pointerType !== 'touch' || tap) setPointer(pointAt(e))
    },
    onPointerLeave: (e) => {
      canvasProps?.onPointerLeave?.(e)
      if (e.pointerType !== 'touch') setPointer(null)
    },
  }

  const hover = (() => {
    if (!pointer) return null
    const plotW = Math.max(1, pointer.w - LABEL_W - PAD)
    const span = Math.max(1, view1 - view0)
    const scale: ZbusXScale = {
      X: (t) => LABEL_W + ((t - view0) / span) * plotW,
      plotLeft: LABEL_W,
      plotRight: LABEL_W + plotW,
      openEnd: Math.max(view1, tr.t1),
    }
    const plotBottom = Math.max(AXIS_H + 1, pointer.h)
    const y = screenYToBase(pointer.y, AXIS_H, plotBottom, yZoom)
    const hit = zbusHitTest(rows, items, AXIS_H + (hasEvents ? 0 : NOTE_H), pointer.x, y, scale)
    if (!hit) return null
    const tip = zbusTip(tr, topology, activity.calls, rows[hit.row]!, hit.placed)
    if (!hit.placed) return { tip, box: null }
    const b = placedBox(hit.placed, hit.rowTop, scale)
    const top = Math.max(AXIS_H, baseYToScreen(b.y0, AXIS_H, plotBottom, yZoom))
    const bottom = Math.min(plotBottom, baseYToScreen(b.y1, AXIS_H, plotBottom, yZoom))
    const left = Math.max(scale.plotLeft, b.x0)
    const right = Math.min(scale.plotRight, b.x1)
    const box = right > left && bottom > top ? { left, top, right, bottom, dot: hit.placed.dot } : null
    return { tip, box }
  })()

  const chip = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1">
      <i className="inline-block size-1.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )

  return (
    <div className="flex flex-col gap-1">
      {toolbar}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground">
        <span>
          channels <span className="font-mono text-foreground">{topology?.channels.length ?? 0}</span>
        </span>
        <span>
          publishes <span className="font-mono text-foreground">{stats.publishes}</span>
        </span>
        <span>
          rejected <span className="font-mono text-rose-400/90">{stats.rejected}</span>
        </span>
        <span>
          notifications <span className="font-mono text-foreground">{stats.notifications}</span>
        </span>
        <span>
          reads <span className="font-mono text-foreground">{stats.reads}</span>
        </span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-2">
          {chip(COL_PUB, 'publish')}
          {chip(COL_READ, 'read')}
          {chip(KIND_COLOR.listener, 'listener')}
          {chip(KIND_COLOR.subscriber, 'subscriber')}
          {chip(KIND_COLOR.async_listener, 'async listener')}
          {chip(COL_ERR, 'error')}
        </span>
      </div>
      <div className="relative w-full select-none">
        <canvas
          ref={canvasRef}
          className={cn(
            'w-full touch-none select-none rounded border border-border/60 bg-slate-950/40 light:bg-muted/40',
            boxZoomArmed ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
          )}
          {...handlers}
        />
        {overlay}
        {hover?.box && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute border border-foreground/80',
              hover.box.dot ? 'rounded-full' : 'rounded-[2px]',
            )}
            style={{
              left: hover.box.left - 1,
              top: hover.box.top - 1,
              width: hover.box.right - hover.box.left + 2,
              height: hover.box.bottom - hover.box.top + 2,
            }}
          />
        )}
        {hover && pointer && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 select-none whitespace-nowrap rounded border border-border/70 bg-background/95 px-2 py-1 font-mono text-[10px] leading-snug text-foreground shadow-md backdrop-blur-sm"
            style={{
              left:
                pointer.x < LABEL_W
                  ? LABEL_W + 8
                  : pointer.x > LABEL_W + 160
                    ? pointer.x - 10
                    : pointer.x + 10,
              top: Math.max(AXIS_H + 4, pointer.y + 8),
              transform:
                pointer.x >= LABEL_W && pointer.x > LABEL_W + 160 ? 'translateX(-100%)' : undefined,
            }}
          >
            {hover.tip.map((line, i) => (
              <div key={i} className={i === 0 ? 'text-foreground' : 'text-muted-foreground'}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Hit-test / pan gutter: TracePanel must use the same width. */
export const ZBUS_LABEL_W = LABEL_W
