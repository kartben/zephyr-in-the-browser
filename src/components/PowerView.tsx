/**
 * Trace → Power: where the CPU's time went, and what the device walk cost.
 *
 * The Timeline band answers "when was the CPU asleep". This answers the
 * questions that need arithmetic or names: how the time divides between states,
 * whether a declared state is ever actually used, how often the policy looked and
 * declined, and which devices the PM core suspended on the way down.
 *
 * Two halves, deliberately different in kind. The summary above is a distribution
 * plus aligned columns — no cards, no grid, per the house rule in
 * docs/trace-networking-plan.md. The canvas below is the device walk, which is
 * genuinely time-series and so shares the Trace window, gestures and box zoom.
 *
 * Devices are named from the ELF, not from the trace: the events carry a pointer
 * only. That resolution needs no gdb session — see debug/elfDevices.ts.
 */

import {
  useEffect,
  useMemo,
  type CanvasHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { applyYZoomTransform, xAt, type YZoom } from '@/components/traceChart'
import { deviceLabel, type ElfDeviceNames } from '@/debug/elfDevices'
import {
  fmtTime,
  medianResidencyNs,
  pmFill,
  pmWindowStats,
  tupleKey,
  walksInView,
  type CpuPowerTimelines,
  type PmDeviceWalk,
  type Trace,
} from '@/ctf'
import {
  dtRankCount,
  dtRankOf,
  findDtState,
  pmStateName,
  pmTupleLabel,
  statesForCpu,
  type PowerStatesInfo,
} from '@/dts'
import { cn } from '@/lib/utils'

export const POWER_LABEL_W = 148
const PAD = 8
const AXIS_H = 22
const ROW_H = 26

const COL_SUSPEND = 'rgba(248, 180, 90, 0.85)'
const COL_RESUME = 'rgba(52, 211, 153, 0.85)'
/** A device that returned -ENOSYS/-ENOTSUP/-EALREADY: visited, not suspended. */
const COL_SKIPPED = 'rgba(148, 163, 184, 0.35)'

type DeviceRow = { dev: number; label: string }

/** Devices the PM core actually ran an action on, in first-seen order. */
function deviceRows(walks: PmDeviceWalk[], names: ElfDeviceNames | null): DeviceRow[] {
  const seen = new Map<number, DeviceRow>()
  for (const walk of walks) {
    for (const action of walk.actions) {
      if (!seen.has(action.dev)) {
        seen.set(action.dev, { dev: action.dev, label: deviceLabel(names, action.dev) })
      }
    }
  }
  return [...seen.values()]
}

function paint(
  canvas: HTMLCanvasElement,
  walks: PmDeviceWalk[],
  rows: DeviceRow[],
  view0: number,
  view1: number,
  yZoom: YZoom | null,
) {
  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth)
  const cssH = Math.max(80, AXIS_H + rows.length * ROW_H + 8)
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  canvas.style.height = `${cssH}px`

  const layout = { labelW: POWER_LABEL_W, pad: PAD, view0, view1, t0: view0 }
  const plotW = Math.max(1, cssW - POWER_LABEL_W - PAD)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, AXIS_H, cssW, Math.max(1, cssH - AXIS_H))
  ctx.clip()
  applyYZoomTransform(ctx, AXIS_H, cssH, yZoom)

  ctx.fillStyle = 'rgba(15, 23, 42, 0.45)'
  ctx.fillRect(POWER_LABEL_W, AXIS_H, plotW, rows.length * ROW_H)

  rows.forEach((row, i) => {
    const y = AXIS_H + i * ROW_H
    ctx.fillStyle = 'rgba(148, 163, 184, 0.95)'
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillText(row.label.slice(0, 20), PAD, y + ROW_H / 2)

    for (const walk of walks) {
      for (const action of walk.actions) {
        if (action.dev !== row.dev) continue
        const x0 = xAt(layout, cssW, action.start)
        const x1 = xAt(layout, cssW, action.end)
        // A skipped device is an instant, so give it a visible minimum width —
        // "the walk visited it and moved on" is information worth seeing.
        const w = Math.max(2, x1 - x0)
        ctx.fillStyle =
          action.ret !== 0 ? COL_SKIPPED : walk.kind === 'suspend' ? COL_SUSPEND : COL_RESUME
        ctx.fillRect(x0, y + 5, w, ROW_H - 12)
      }
    }
  })
  ctx.restore()

  // Axis last, unclipped, so the walk cannot draw over it.
  ctx.fillStyle = 'rgba(148, 163, 184, 0.75)'
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText('device pm', PAD, AXIS_H / 2)
}

export function PowerView({
  tr,
  timelines,
  dt,
  deviceNames,
  view0,
  view1,
  eventCount,
  canvasRef,
  canvasProps,
  overlay,
  boxZoomArmed = false,
  yZoom = null,
  toolbar,
}: {
  tr: Trace
  timelines: CpuPowerTimelines
  dt: PowerStatesInfo | null
  deviceNames: ElfDeviceNames | null
  view0: number
  view1: number
  /** snap.revision — the repaint signal, not a count anyone reads. */
  eventCount: number
  canvasRef: RefObject<HTMLCanvasElement | null>
  canvasProps?: CanvasHTMLAttributes<HTMLCanvasElement>
  overlay?: ReactNode
  boxZoomArmed?: boolean
  yZoom?: YZoom | null
  toolbar?: ReactNode
}) {
  const cpus = useMemo(
    () => [...timelines.segs.keys()].sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelines, eventCount],
  )
  const walks = useMemo(
    () => walksInView(timelines, view0, view1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelines, view0, view1, eventCount],
  )
  /*
   * Rows come from every walk in the trace, not just the visible ones, so the
   * lane list does not reshuffle as the window moves — the same reason
   * laneOrder() refuses to sort thread lanes by busy time.
   */
  const rows = useMemo(
    () => deviceRows(timelines.walks, deviceNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelines, deviceNames, eventCount],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paint(canvas, walks, rows, view0, view1, yZoom)
  }, [walks, rows, view0, view1, yZoom, canvasRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint(canvas, walks, rows, view0, view1, yZoom))
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [walks, rows, view0, view1, yZoom, canvasRef])

  return (
    <div className="flex flex-col gap-2">
      {toolbar}
      {cpus.map((cpu) => (
        <CpuSummary key={cpu} cpu={cpu} timelines={timelines} dt={dt} tr={tr} />
      ))}

      {rows.length > 0 && (
        <div className="relative">
          <canvas
            ref={canvasRef}
            {...canvasProps}
            className={cn(
              'w-full touch-none select-none',
              boxZoomArmed ? 'cursor-crosshair' : 'cursor-grab',
            )}
          />
          {overlay}
          <div className="flex flex-wrap items-center gap-x-3 px-1 pt-1 text-[10px] text-muted-foreground">
            {/*
              A suspend walk is a couple of milliseconds wide and happens once a
              sleep, so at most windows the canvas is legitimately empty. Saying so
              — with the total — is the difference between "nothing here" and
              "nothing here yet, zoom".
            */}
            <span className={walks.length === 0 ? 'text-amber-500/80' : undefined}>
              {walks.length === 0
                ? `no walk in this window (${timelines.walks.length} in the trace — zoom out)`
                : `${walks.length} of ${timelines.walks.length} walks`}
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block size-2 rounded-sm" style={{ background: COL_SUSPEND }} />
              suspend
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block size-2 rounded-sm" style={{ background: COL_RESUME }} />
              resume
            </span>
            <span className="inline-flex items-center gap-1">
              <i className="inline-block size-2 rounded-sm" style={{ background: COL_SKIPPED }} />
              no PM support
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function CpuSummary({
  cpu,
  timelines,
  dt,
  tr,
}: {
  cpu: number
  timelines: CpuPowerTimelines
  dt: PowerStatesInfo | null
  tr: Trace
}) {
  /*
   * Over the whole retained trace, deliberately not the Trace window.
   *
   * A distribution is a readout, not a chart: shares that silently change because
   * the shared window moved — and that can read 0.0% for a state whose entry count
   * is plainly 5 — are worse than no shares at all. An earlier attempt kept these
   * on the view and auto-fitted the window when the tab opened, which was fragile
   * in every variant (any "fit once" gate fires at some arbitrary early moment,
   * and then the numbers are wrong for the rest of the session). The device walk
   * below still follows the window, because that one genuinely is a chart and has
   * a toolbar and an axis to say so.
   */
  const view0 = tr.t0
  const view1 = Math.max(tr.t0 + 1, tr.t1)
  const stats = pmWindowStats(timelines, cpu, view0, view1)
  const rankCount = dt ? dtRankCount(dt, cpu) : 0

  /*
   * Rows in devicetree ladder order when there is one, so shallow-to-deep reads
   * down the list and a declared-but-unused state keeps its place instead of
   * vanishing. Falls back to whatever the guest actually reported.
   */
  const declared = dt ? statesForCpu(dt, cpu) : []
  const entered = [...timelines.stats.values()].filter((s) => s.cpu === cpu)
  const rows = declared.length
    ? declared.map((state) => ({
        label: state.label,
        state: state.state ?? 0,
        substateId: state.substateId,
        minResidencyUs: state.minResidencyUs,
        stat: entered.find(
          (s) => s.state === (state.state ?? -1) && s.substateId === state.substateId,
        ),
      }))
    : entered.map((s) => ({
        label: pmTupleLabel(null, s.state, s.substateId),
        state: s.state,
        substateId: s.substateId,
        minResidencyUs: null,
        stat: s,
      }))

  const declines = timelines.decisions.filter((d) => d.cpu === cpu && d.declined).length
  const decisions = timelines.decisions.filter((d) => d.cpu === cpu).length
  const spanNs = Math.max(1, view1 - view0)

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 px-1 font-mono text-[10px] text-muted-foreground">
        <span className="text-foreground">cpu{cpu}</span>
        <span>
          slept <span className="text-foreground">{(stats.sleptFraction * 100).toFixed(1)}%</span>
        </span>
        {stats.deepest != null && (
          <span>
            deepest <span className="text-foreground">{pmStateName(stats.deepest)}</span>
          </span>
        )}
        <span className="ml-auto">whole trace</span>
      </div>

      {/*
        The whole distribution in one strip, in the same ramp as the Timeline band
        so the two views teach each other. The unfilled remainder is ACTIVE — it
        needs no colour, exactly as in the band.
      */}
      <div className="mx-1 flex h-2 overflow-hidden rounded-sm bg-slate-900/60">
        {rows.map((row) => {
          const ns = stats.byTuple.get(tupleKey(cpu, row.state, row.substateId)) ?? 0
          if (ns <= 0) return null
          const rank = (dt && dtRankOf(dt, cpu, row.state, row.substateId)) ?? row.state
          return (
            <div
              key={`${row.state}/${row.substateId}`}
              title={`${row.label} · ${((ns / spanNs) * 100).toFixed(1)}%`}
              style={{
                width: `${(ns / spanNs) * 100}%`,
                background: pmFill(rank, rankCount, row.state).fill,
              }}
            />
          )
        })}
      </div>

      <table className="w-full font-mono text-[10px] tabular-nums">
        <tbody>
          {rows.map((row) => {
            const ns = stats.byTuple.get(tupleKey(cpu, row.state, row.substateId)) ?? 0
            const rank = (dt && dtRankOf(dt, cpu, row.state, row.substateId)) ?? row.state
            const never = !row.stat || row.stat.entries === 0
            const dtState = dt ? findDtState(dt, cpu, row.state, row.substateId) : null
            return (
              <tr
                key={`${row.state}/${row.substateId}`}
                className={never ? 'text-muted-foreground/50' : 'text-muted-foreground'}
              >
                <td className="w-4 py-0.5">
                  <i
                    className="inline-block size-2 rounded-sm"
                    style={{
                      background: never
                        ? 'transparent'
                        : pmFill(rank, rankCount, row.state).fill,
                      boxShadow: never ? 'inset 0 0 0 1px rgba(148,163,184,0.35)' : undefined,
                    }}
                  />
                </td>
                <td className="py-0.5 pr-2 text-foreground/90">{row.label}</td>
                <td className="py-0.5 pr-2 text-right">
                  {never ? '—' : `${((ns / spanNs) * 100).toFixed(1)}%`}
                </td>
                <td className="py-0.5 pr-2 text-right">
                  {never ? '0×' : `${row.stat!.entries}×`}
                </td>
                <td className="py-0.5 pr-2 text-right">
                  {never
                    ? row.minResidencyUs != null
                      ? `min ${fmtTime(row.minResidencyUs * 1000)}`
                      : ''
                    : `med ${fmtTime(medianResidencyNs(row.stat!))}`}
                </td>
                <td className="py-0.5 text-right text-muted-foreground/70">
                  {dtState?.exitLatencyUs ? `exit ${fmtTime(dtState.exitLatencyUs * 1000)}` : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="px-1 font-mono text-[10px] text-muted-foreground">
        {/*
          Declines are the other half of the story: a policy that looked and chose
          to stay awake is not the same as one that never looked.
        */}
        policy declined <span className="text-foreground">{declines}</span> of {decisions}
        {rows.some((r) => !r.stat || r.stat.entries === 0) && dt && (
          <span> · dim rows are declared in devicetree and never entered</span>
        )}
        {timelines.dropped.exitWithoutEnter + timelines.dropped.enterWithoutExit > 0 && (
          <span className="text-amber-500">
            {' · '}
            {timelines.dropped.exitWithoutEnter + timelines.dropped.enterWithoutExit} unpaired
          </span>
        )}
      </div>
    </div>
  )
}
