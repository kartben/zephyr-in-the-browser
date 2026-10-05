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
 * zoom, like the Networking and Power tabs.
 */

import {
  useEffect,
  useMemo,
  useRef,
  type CanvasHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { applyYZoomTransform, type YZoom } from '@/components/traceChart'
import {
  fmtTime,
  hasZbusEvents,
  niceTimeStep,
  reconstructZbus,
  threadLabel,
  zbusErrno,
  zbusWindowStats,
  type Trace,
  type ZbusActivity,
  type ZbusCall,
} from '@/ctf'
import { type ZbusObserverKind, type ZbusTopology } from '@/debug/elfZbus'
import { cn } from '@/lib/utils'

const LABEL_W = 156
const PAD = 8
const AXIS_H = 28
const CHAN_H = 32
const OBS_H = 22

const COL_PUB = 'rgba(52, 211, 153, 0.8)'
const COL_READ = 'rgba(148, 163, 184, 0.75)'
const COL_CLAIM = 'rgba(251, 191, 36, 0.35)'
const COL_ERR = 'rgba(248, 113, 113, 0.95)'
const COL_LINK = 'rgba(148, 163, 184, 0.55)'
const COL_TEXT = 'rgba(226, 232, 240, 0.95)'
const COL_MUTED = 'rgba(148, 163, 184, 0.85)'

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

type Row =
  | { kind: 'chan'; chan: number; label: string; detail: string; group: number }
  | {
      kind: 'obs'
      chan: number
      obs: number
      label: string
      obsKind: ZbusObserverKind | null
      last: boolean
      group: number
    }

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`

/** Rows from the image's topology, plus any channel or observer only the trace knows. */
function buildRows(topo: ZbusTopology | null, activity: ZbusActivity): Row[] {
  const rows: Row[] = []
  const channels: number[] = topo ? topo.channels.map((c) => c.addr >>> 0) : []
  for (const c of activity.calls) if (!channels.includes(c.chan)) channels.push(c.chan)

  channels.forEach((chan, group) => {
    const info = topo?.channelByAddr32.get(chan)
    const detail = info
      ? [
          info.messageSize !== null ? `${info.messageSize} B` : null,
          info.validator ? 'validated' : null,
          `${info.observers.length} obs`,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'not in the image'
    rows.push({ kind: 'chan', chan, label: info?.name ?? hex(chan), detail, group })

    const observers: number[] = info ? info.observers.map((o) => o.addr >>> 0) : []
    // Observers added at run time are not in the image: they show up when told.
    for (const c of activity.calls) {
      if (c.chan !== chan) continue
      for (const n of c.notifies) if (!observers.includes(n.obs)) observers.push(n.obs)
    }
    observers.forEach((obs, i) => {
      const o = topo?.observerByAddr32.get(obs)
      rows.push({
        kind: 'obs',
        chan,
        obs,
        label: o?.name ?? hex(obs),
        obsKind: o?.kind ?? null,
        last: i === observers.length - 1,
        group,
      })
    })
  })
  return rows
}

function rowHeight(r: Row): number {
  return r.kind === 'chan' ? CHAN_H : OBS_H
}

function paint(
  canvas: HTMLCanvasElement,
  tr: Trace,
  topo: ZbusTopology | null,
  activity: ZbusActivity,
  rows: Row[],
  hasEvents: boolean,
  view0: number,
  view1: number,
  follow: boolean,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const body = rows.reduce((h, r) => h + rowHeight(r), 0)
  const note = hasEvents ? 0 : 40
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

  // Axis, as the other Trace tabs draw it.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'alphabetic'
  const step = niceTimeStep(span, Math.max(3, Math.floor(plotW / 72)))
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)'
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
    ctx.fillStyle = 'rgba(34, 197, 94, 0.95)'
    ctx.fillText('LIVE', Math.max(LABEL_W, cssW - 32), 12)
  }

  if (!hasEvents) {
    ctx.fillStyle = COL_MUTED
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
    ctx.fillText('No zbus events in this trace. The channels and observers come from the image.', 8, AXIS_H + 16)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.95)'
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
    ctx.strokeStyle = COL_LINK
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(clampX(X(ta)), y)
    ctx.lineTo(clampX(X(tb)), y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const callsByChan = new Map<number, ZbusCall[]>()
  for (const c of activity.calls) {
    const list = callsByChan.get(c.chan) ?? []
    list.push(c)
    callsByChan.set(c.chan, list)
  }

  let y = AXIS_H + note
  for (const r of rows) {
    const h = rowHeight(r)
    ctx.fillStyle = r.group % 2 === 0 ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.18)'
    ctx.fillRect(0, y, cssW, h)
    const mid = y + h / 2
    const calls = callsByChan.get(r.chan) ?? []
    ctx.textBaseline = 'middle'

    if (r.kind === 'chan') {
      ctx.fillStyle = COL_TEXT
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label, 4, mid - 6)
      ctx.fillStyle = COL_MUTED
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillText(r.detail, 4, mid + 7)

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      // A claim holds the channel from claim's return to finish.
      for (const c of calls) {
        if (c.op !== 'claim' || c.ret !== 0 || c.t1 === null) continue
        const fin = calls.find((f) => f.op === 'finish' && f.thread === c.thread && f.t0 >= c.t1!)
        bar(c.t1, end(fin?.t0 ?? null), y + 4, h - 8, COL_CLAIM, 'claimed')
      }
      for (const c of calls) {
        const who = c.thread !== null ? threadLabel(tr, c.thread) : 'ISR'
        const failed = c.ret !== null && c.ret < 0
        if (c.op === 'pub' || c.op === 'notify') {
          const label = failed
            ? `${who} ${zbusErrno(c.ret!)}`
            : c.op === 'notify'
              ? `${who} · notify`
              : who
          bar(c.t0, end(c.t1), y + 5, 13, failed ? COL_ERR : COL_PUB, label, failed)
        } else if (c.op === 'read') {
          bar(c.t0, end(c.t1), y + h - 9, 6, failed ? COL_ERR : COL_READ)
        } else if (c.op === 'claim' || c.op === 'finish') {
          bar(c.t0, end(c.t1), y + h - 9, 6, failed ? COL_ERR : COL_CLAIM)
        }
      }
    } else {
      const color = KIND_COLOR[r.obsKind ?? 'unknown']
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillStyle = COL_MUTED
      ctx.fillText(r.last ? '└' : '├', 6, mid)
      const name = r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label
      ctx.fillStyle = color
      ctx.fillText(name, 18, mid)
      ctx.fillStyle = COL_MUTED
      ctx.font = '8px ui-sans-serif, system-ui, sans-serif'
      const tag = KIND_TAG[r.obsKind ?? 'unknown']
      ctx.fillText(tag, LABEL_W - ctx.measureText(tag).width - 6, mid)

      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
      const told = calls.flatMap((c) => c.notifies.filter((n) => n.obs === r.obs))
      for (const n of told) {
        const failed = n.ret !== null && n.ret < 0
        // A listener's notification is its callback, so it gets a name.
        const listener = r.obsKind === 'listener'
        bar(
          n.t0,
          end(n.t1),
          listener ? mid - 5 : mid - 4,
          listener ? 10 : 8,
          failed ? COL_ERR : color,
          failed ? zbusErrno(n.ret!) : listener ? 'callback' : undefined,
        )
      }

      if (r.obsKind === 'subscriber' || r.obsKind === 'msg_subscriber' || r.obsKind === null) {
        for (const w of activity.wakes) {
          if (w.obs !== r.obs || w.chan !== r.chan) continue
          const n = [...told].reverse().find((x) => x.t0 <= w.t)
          if (n) link(n.t0, w.t, mid)
          if (w.t >= view0 && w.t <= view1) {
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(X(w.t), mid, 3, 0, Math.PI * 2)
            ctx.fill()
          }
          // The read that follows, by the thread that woke.
          const read = calls.find((c) => c.op === 'read' && c.thread === w.thread && c.t0 >= w.t)
          if (read) {
            link(w.t, read.t0, mid)
            bar(read.t0, end(read.t1), mid - 5, 10, COL_READ, `${threadLabel(tr, read.thread!)} · read`)
          }
        }
      }
      if (r.obsKind === 'async_listener' || r.obsKind === null) {
        for (const run of activity.runs) {
          if (run.chan !== r.chan || topo?.observerByWork32.get(run.work)?.addr !== r.obs) continue
          const n = [...told].reverse().find((x) => x.t0 <= run.t0)
          if (n) link(n.t0, run.t0, mid)
          const who = run.thread !== null ? threadLabel(tr, run.thread) : 'ISR'
          bar(run.t0, end(run.t1), mid - 5, 10, color, who)
        }
      }
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)'
    ctx.beginPath()
    ctx.moveTo(LABEL_W, y + h - 0.5)
    ctx.lineTo(LABEL_W + plotW, y + h - 0.5)
    ctx.stroke()
    y += h
  }

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
  const stats = useMemo(() => zbusWindowStats(activity, view0, view1), [activity, view0, view1])
  const latest = useRef({ activity, rows, hasEvents, yZoom })
  latest.current = { activity, rows, hasEvents, yZoom }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, tr, topology, activity, rows, hasEvents, view0, view1, follow, yZoom)
  }, [tr, topology, activity, rows, hasEvents, view0, view1, follow, canvasRef, yZoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const l = latest.current
      paint(canvas, tr, topology, l.activity, l.rows, l.hasEvents, view0, view1, follow, l.yZoom)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [tr, topology, view0, view1, follow, canvasRef])

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
            'w-full touch-none select-none rounded border border-border/60 bg-slate-950/40',
            boxZoomArmed ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
          )}
          {...canvasProps}
        />
        {overlay}
      </div>
    </div>
  )
}

/** Hit-test / pan gutter: TracePanel must use the same width. */
export const ZBUS_LABEL_W = LABEL_W
