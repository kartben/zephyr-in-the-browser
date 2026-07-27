/**
 * Live diagram of Zephyr's tracing pipeline sample: sensors → msgq →
 * aggregator → frame condvar → consumers, with a bus/storage spur.
 *
 * Colours follow the CTF Trace panel legend (run/ready/blocked/sleep). Nodes
 * pulse while running; recent named_event markers flash a ring; edges glow
 * when hot (traffic or a waiter).
 */

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { STATE_COLOR, STATE_LABEL, type ThreadState } from '@/ctf'
import type { Trace } from '@/ctf'
import { pipelineFromTrace, type PipelineEdgeLive, type PipelineNodeLive } from '@/pipeline/fromTrace'
import type { PipelineNodeId } from '@/pipeline/topology'

/** SVG layout coordinates (viewBox 0 0 420 200). */
const POS: Record<PipelineNodeId, { x: number; y: number }> = {
  sensor_temp: { x: 44, y: 36 },
  sensor_press: { x: 44, y: 88 },
  sensor_imu: { x: 44, y: 140 },
  aggregator: { x: 210, y: 88 },
  consumer0: { x: 360, y: 36 },
  consumer1: { x: 360, y: 140 },
  storage: { x: 210, y: 176 },
}

const EDGE_HUB = {
  sensor_q: { x: 118, y: 88 },
  frame: { x: 286, y: 88 },
  bus: { x: 210, y: 132 },
} as const

const NODE_W = 72
const NODE_H = 28

function nodeFill(state: ThreadState | null): string {
  if (!state || state === 'dead') return 'color-mix(in oklch, var(--muted) 80%, transparent)'
  return STATE_COLOR[state]
}

function NodeChip({ node }: { node: PipelineNodeLive }) {
  const { x, y } = POS[node.id]
  const running = node.state === 'run'
  const fill = nodeFill(node.state)
  const title = [
    node.id,
    node.prio != null ? `prio ${node.prio}` : null,
    node.state ? STATE_LABEL[node.state] : 'offline',
    node.reason || null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <g transform={`translate(${x - NODE_W / 2} ${y - NODE_H / 2})`} className="pipeline-node">
      <title>{title}</title>
      {node.flash && (
        <rect
          x={-3}
          y={-3}
          width={NODE_W + 6}
          height={NODE_H + 6}
          rx={8}
          className="pipeline-flash"
          fill="none"
          stroke="var(--foreground)"
          strokeWidth={1.5}
          opacity={0.85}
        />
      )}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill={fill}
        className={cn(running && 'pipeline-run')}
        opacity={node.state ? 0.92 : 0.35}
      />
      <text
        x={NODE_W / 2}
        y={NODE_H / 2 + 0.5}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-[var(--background)] font-mono text-[10px] font-semibold"
        style={{ fill: node.state === 'slp' || node.state === 'sus' || !node.state ? 'var(--foreground)' : undefined }}
      >
        {node.label}
      </text>
      {node.prio != null && (
        <text
          x={NODE_W - 4}
          y={8}
          textAnchor="end"
          className="fill-[var(--background)] font-mono text-[7px] opacity-80"
          style={{
            fill:
              node.state === 'slp' || node.state === 'sus' || !node.state
                ? 'var(--muted-foreground)'
                : undefined,
          }}
        >
          p{node.prio}
        </text>
      )}
    </g>
  )
}

function EdgeGlyph({
  edge,
  x,
  y,
}: {
  edge: PipelineEdgeLive
  x: number
  y: number
}) {
  const title = [edge.label, edge.kind, edge.waiter ? `waiting: ${edge.waiter}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <g transform={`translate(${x} ${y})`} className={cn('pipeline-edge', edge.hot && 'pipeline-edge-hot')}>
      <title>{title}</title>
      <rect
        x={-22}
        y={-11}
        width={44}
        height={22}
        rx={11}
        fill="var(--card)"
        stroke={edge.hot ? 'var(--primary)' : 'var(--border)'}
        strokeWidth={edge.hot ? 1.6 : 1}
      />
      <text
        textAnchor="middle"
        dominantBaseline="middle"
        y={0.5}
        className="fill-[var(--muted-foreground)] font-mono text-[9px]"
        style={{ fill: edge.hot ? 'var(--foreground)' : undefined }}
      >
        {edge.label}
      </text>
    </g>
  )
}

function Wire({
  d,
  hot,
}: {
  d: string
  hot: boolean
}) {
  return (
    <path
      d={d}
      fill="none"
      stroke={hot ? 'var(--primary)' : 'var(--border)'}
      strokeWidth={hot ? 1.8 : 1.2}
      strokeLinecap="round"
      className={cn(hot && 'pipeline-wire-hot')}
      opacity={hot ? 0.95 : 0.7}
    />
  )
}

export function PipelineView({
  trace,
  eventCount,
}: {
  trace: Trace | null
  /** Bumps when hostTrace appends — the Trace object is mutated in place. */
  eventCount: number
}) {
  const live = useMemo(
    () => (trace && trace.events.length > 0 ? pipelineFromTrace(trace) : null),
    // eventCount is the live-edge signal; Trace is the same object across polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trace, eventCount],
  )

  if (!live) {
    return (
      <p className="px-1 pb-1 text-[11px] leading-relaxed text-muted-foreground">
        Waiting for CTF… the pipeline diagram lights up as sensors, the aggregator, and consumers
        schedule.
      </p>
    )
  }

  const byId = new Map(live.nodes.map((n) => [n.id, n]))
  const edgeById = new Map(live.edges.map((e) => [e.id, e]))
  const q = edgeById.get('sensor_q')!
  const frame = edgeById.get('frame')!
  const bus = edgeById.get('bus')!

  const metrics = [
    live.frameSeq != null ? `frame #${live.frameSeq}` : null,
    live.frameAvg != null ? `avg ${live.frameAvg}` : null,
    live.msgqDepth != null ? `msgq ${live.msgqDepth}` : null,
  ].filter(Boolean)

  return (
    <div className="pipeline-view flex flex-col gap-1.5 px-1 pb-1">
      <svg
        viewBox="0 0 420 200"
        className="h-auto w-full select-none"
        role="img"
        aria-label="Live sensor pipeline: sensors feed a message queue into the aggregator, which wakes consumers on a condition variable and shares a bus with storage"
      >
        {/* Wires: sensors → msgq → aggregator → frame → consumers; aggregator → bus → storage */}
        <Wire
          hot={q.hot}
          d={`M ${POS.sensor_temp.x + NODE_W / 2 - 8} ${POS.sensor_temp.y}
             C 90 ${POS.sensor_temp.y}, 90 ${EDGE_HUB.sensor_q.y}, ${EDGE_HUB.sensor_q.x - 22} ${EDGE_HUB.sensor_q.y}`}
        />
        <Wire
          hot={q.hot}
          d={`M ${POS.sensor_press.x + NODE_W / 2 - 8} ${POS.sensor_press.y}
             L ${EDGE_HUB.sensor_q.x - 22} ${EDGE_HUB.sensor_q.y}`}
        />
        <Wire
          hot={q.hot}
          d={`M ${POS.sensor_imu.x + NODE_W / 2 - 8} ${POS.sensor_imu.y}
             C 90 ${POS.sensor_imu.y}, 90 ${EDGE_HUB.sensor_q.y}, ${EDGE_HUB.sensor_q.x - 22} ${EDGE_HUB.sensor_q.y}`}
        />
        <Wire
          hot={q.hot}
          d={`M ${EDGE_HUB.sensor_q.x + 22} ${EDGE_HUB.sensor_q.y}
             L ${POS.aggregator.x - NODE_W / 2 + 8} ${POS.aggregator.y}`}
        />
        <Wire
          hot={frame.hot}
          d={`M ${POS.aggregator.x + NODE_W / 2 - 8} ${POS.aggregator.y}
             L ${EDGE_HUB.frame.x - 22} ${EDGE_HUB.frame.y}`}
        />
        <Wire
          hot={frame.hot}
          d={`M ${EDGE_HUB.frame.x + 22} ${EDGE_HUB.frame.y}
             C 320 ${EDGE_HUB.frame.y}, 320 ${POS.consumer0.y}, ${POS.consumer0.x - NODE_W / 2 + 8} ${POS.consumer0.y}`}
        />
        <Wire
          hot={frame.hot}
          d={`M ${EDGE_HUB.frame.x + 22} ${EDGE_HUB.frame.y}
             C 320 ${EDGE_HUB.frame.y}, 320 ${POS.consumer1.y}, ${POS.consumer1.x - NODE_W / 2 + 8} ${POS.consumer1.y}`}
        />
        <Wire
          hot={bus.hot}
          d={`M ${POS.aggregator.x} ${POS.aggregator.y + NODE_H / 2 - 4}
             L ${EDGE_HUB.bus.x} ${EDGE_HUB.bus.y - 11}`}
        />
        <Wire
          hot={bus.hot}
          d={`M ${EDGE_HUB.bus.x} ${EDGE_HUB.bus.y + 11}
             L ${POS.storage.x} ${POS.storage.y - NODE_H / 2 + 4}`}
        />

        <EdgeGlyph edge={q} x={EDGE_HUB.sensor_q.x} y={EDGE_HUB.sensor_q.y} />
        <EdgeGlyph edge={frame} x={EDGE_HUB.frame.x} y={EDGE_HUB.frame.y} />
        <EdgeGlyph edge={bus} x={EDGE_HUB.bus.x} y={EDGE_HUB.bus.y} />

        {PIPELINE_ORDER.map((id) => (
          <NodeChip key={id} node={byId.get(id)!} />
        ))}
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {metrics.length > 0 ? (
          metrics.map((m) => (
            <span key={m} className="text-foreground/80">
              {m}
            </span>
          ))
        ) : (
          <span>listening for named events…</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <LegendDot color={STATE_COLOR.run} label="run" />
          <LegendDot color={STATE_COLOR.blk} label="blk" />
          <LegendDot color={STATE_COLOR.slp} label="slp" />
        </span>
      </div>
    </div>
  )
}

const PIPELINE_ORDER: PipelineNodeId[] = [
  'sensor_temp',
  'sensor_press',
  'sensor_imu',
  'aggregator',
  'consumer0',
  'consumer1',
  'storage',
]

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
