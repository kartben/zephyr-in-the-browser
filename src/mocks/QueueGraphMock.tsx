import { useEffect, useMemo, useState } from 'react'
import {
  capacityFillFraction,
  compactCapacity,
  compactCount,
} from '@/components/queueGraph/display'
import { roundedOrthogonalPath, validateQueueGraphLayout } from '@/components/queueGraph/geometry'
import {
  layoutSemanticGraph,
  type LayoutEdge,
  type LayoutNode,
  type QueueGraphLayout,
} from '@/components/queueGraph/layout'
import {
  flowActionColor,
  flowActionLabel,
  type FlowAction,
  type PortRole,
} from '@/components/queueGraph/model'
import { queueGraphLargeCapacityMock, queueGraphMock } from './queueGraphMockData'

const OBJECT_FILL = '#101a2b'
const OBJECT_STROKE = '#7c8ba1'
const THREAD_FILL = '#1b1830'
const THREAD_STROKE = '#a78bfa'
const TEXT = '#f1f5f9'
const MUTED = '#94a3b8'
const PANEL = '#080d18'

function markerId(action: FlowAction): string {
  return `mock-arrow-${action}`
}

function portRoleLabel(role: PortRole): string {
  switch (role) {
    case 'tail-in':
      return 'tail · in'
    case 'head-in':
      return 'head · in'
    case 'head-out':
      return 'head · out'
    case 'top-in':
      return 'top · push'
    case 'top-out':
      return 'top · pop'
    case 'thread-in':
      return 'flow in'
    case 'thread-out':
      return 'flow out'
  }
}

function nodeKindLabel(node: LayoutNode): string {
  if (node.kind === 'thread') return 'thread'
  if (node.kind === 'msgq') return 'message queue'
  if (node.kind === 'fifo') return 'fifo'
  if (node.kind === 'queue') return 'queue'
  if (node.kind === 'lifo') return 'lifo'
  return 'fixed stack'
}

function ThreadShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'thread') return null
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        fill={THREAD_FILL}
        stroke={THREAD_STROKE}
        strokeWidth={1.5}
      />
      <circle cx={20} cy={node.height / 2} r={6} fill="#a78bfa" fillOpacity={0.9} />
      <text
        x={35}
        y={node.height / 2 - 7}
        fill={TEXT}
        fontSize={13}
        fontWeight={650}
      >
        {node.label}
      </text>
      <text x={35} y={node.height / 2 + 11} fill={MUTED} fontSize={9.5}>
        {node.detail ?? 'thread'}
      </text>
    </>
  )
}

function MsgqShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'msgq') return null
  const cap = Math.max(1, node.capacity ?? 1)
  const showExactSlots = node.capacity != null && node.capacity <= 10
  const visibleSlots = showExactSlots ? cap : 0
  const gap = 4
  const trackX = 24
  const trackY = node.height / 2 - 2
  const trackW = node.width - 48
  const slotW = showExactSlots ? (trackW - gap * (visibleSlots - 1)) / visibleSlots : 0
  const fillFraction = capacityFillFraction(node.depth, cap)
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={14}
        fill={OBJECT_FILL}
        stroke={OBJECT_STROKE}
        strokeWidth={1.4}
      />
      <text x={18} y={24} fill={TEXT} fontSize={13} fontWeight={700}>
        {node.label}
      </text>
      <text x={node.width - 18} y={24} textAnchor="end" fill={MUTED} fontSize={9.5}>
        msgq · {compactCapacity(node.depth, node.capacity)}
      </text>
      {showExactSlots ? (
        Array.from({ length: visibleSlots }, (_, index) => (
          <rect
            key={index}
            x={trackX + index * (slotW + gap)}
            y={trackY}
            width={slotW}
            height={24}
            rx={4}
            fill={index < node.depth ? '#38bdf8' : '#09111f'}
            fillOpacity={index < node.depth ? 0.62 : 1}
            stroke={index < node.depth ? '#7dd3fc' : '#27364d'}
            strokeWidth={0.8}
          />
        ))
      ) : (
        <>
          <rect
            x={trackX}
            y={trackY}
            width={trackW}
            height={24}
            rx={6}
            fill="#09111f"
            stroke="#27364d"
            strokeWidth={0.8}
          />
          {fillFraction > 0 && (
            <rect
              x={trackX}
              y={trackY}
              width={Math.max(1, trackW * fillFraction)}
              height={24}
              rx={Math.min(6, Math.max(0.5, (trackW * fillFraction) / 2))}
              fill="#38bdf8"
              fillOpacity={0.62}
              stroke="#7dd3fc"
              strokeWidth={0.8}
            />
          )}
        </>
      )}
      <text x={18} y={node.height - 12} fill={MUTED} fontSize={8.5}>
        TAIL
      </text>
      <text x={node.width - 18} y={node.height - 12} textAnchor="end" fill={MUTED} fontSize={8.5}>
        HEAD
      </text>
    </>
  )
}

function FifoShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'fifo' && node.kind !== 'queue') return null
  const itemCount = Math.min(5, Math.max(1, node.depth))
  const startX = 58
  const centerY = node.height / 2 + 6
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={14}
        fill={OBJECT_FILL}
        stroke={OBJECT_STROKE}
        strokeWidth={1.4}
      />
      <text x={18} y={24} fill={TEXT} fontSize={13} fontWeight={700}>
        {node.label}
      </text>
      <text x={node.width - 18} y={24} textAnchor="end" fill={MUTED} fontSize={9.5}>
        {node.kind} · depth {node.depth}
      </text>
      <line x1={42} y1={centerY} x2={node.width - 42} y2={centerY} stroke="#334155" strokeWidth={2} />
      {Array.from({ length: itemCount }, (_, index) => {
        const x = startX + index * 29
        return (
          <g key={index}>
            <circle cx={x} cy={centerY} r={10} fill="#172b3d" stroke="#7dd3fc" strokeWidth={1} />
            <circle cx={x} cy={centerY} r={3} fill="#7dd3fc" fillOpacity={0.75} />
          </g>
        )
      })}
      <text x={18} y={node.height - 12} fill={MUTED} fontSize={8.5}>
        TAIL
      </text>
      <text x={node.width - 18} y={node.height - 12} textAnchor="end" fill={MUTED} fontSize={8.5}>
        HEAD
      </text>
    </>
  )
}

function VerticalStackShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'stack' && node.kind !== 'lifo') return null
  const fixed = node.kind === 'stack'
  const showExactSlots = fixed && node.capacity != null && node.capacity <= 8
  const slots = showExactSlots ? node.capacity! : Math.min(6, Math.max(1, node.depth))
  const bodyW = 96
  const bodyH = 70
  const bodyX = (node.width - bodyW) / 2
  const bodyY = 54
  const gap = 3
  const slotH = (bodyH - gap * (slots - 1)) / slots
  const fillFraction =
    fixed && node.capacity != null ? capacityFillFraction(node.depth, node.capacity) : 0
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={14}
        fill={OBJECT_FILL}
        stroke={OBJECT_STROKE}
        strokeWidth={1.4}
      />
      <text x={16} y={25} fill={TEXT} fontSize={12.5} fontWeight={700}>
        {node.label}
      </text>
      <text x={16} y={40} fill={MUTED} fontSize={9.5}>
        {fixed ? compactCapacity(node.depth, node.capacity) : `depth ${compactCount(node.depth)}`}
      </text>
      <path
        d={`M${bodyX},${bodyY}V${bodyY + bodyH}H${bodyX + bodyW}V${bodyY}`}
        fill="#09111f"
        stroke="#64748b"
        strokeWidth={1.2}
      />
      {showExactSlots ? (
        Array.from({ length: slots }, (_, index) => {
          const filled = index >= slots - node.depth
          return (
            <rect
              key={index}
              x={bodyX + 5}
              y={bodyY + index * (slotH + gap)}
              width={bodyW - 10}
              height={slotH}
              rx={2}
              fill={filled ? '#38bdf8' : '#0c1727'}
              fillOpacity={filled ? 0.58 : 1}
              stroke={filled ? '#7dd3fc' : '#24334a'}
              strokeWidth={0.7}
            />
          )
        })
      ) : fixed ? (
        <>
          <rect
            x={bodyX + 5}
            y={bodyY}
            width={bodyW - 10}
            height={bodyH}
            rx={3}
            fill="#0c1727"
            stroke="#24334a"
            strokeWidth={0.7}
          />
          {fillFraction > 0 && (
            <rect
              x={bodyX + 5}
              y={bodyY + bodyH - Math.max(1, bodyH * fillFraction)}
              width={bodyW - 10}
              height={Math.max(1, bodyH * fillFraction)}
              rx={2}
              fill="#38bdf8"
              fillOpacity={0.58}
              stroke="#7dd3fc"
              strokeWidth={0.7}
            />
          )}
        </>
      ) : (
        Array.from({ length: slots }, (_, index) => (
          <rect
            key={index}
            x={bodyX + 5}
            y={bodyY + index * (slotH + gap)}
            width={bodyW - 10}
            height={slotH}
            rx={2}
            fill="#38bdf8"
            fillOpacity={0.58}
            stroke="#7dd3fc"
            strokeWidth={0.7}
          />
        ))
      )}
      <path
        d={`M${bodyX - 8},${bodyY + 8}L${bodyX},${bodyY}L${bodyX + 8},${bodyY + 8}`}
        fill="none"
        stroke="#cbd5e1"
        strokeWidth={1}
      />
      <text x={bodyX - 12} y={bodyY + 3} textAnchor="end" fill={MUTED} fontSize={8.5}>
        TOP
      </text>
      <text x={node.width / 2} y={node.height - 10} textAnchor="middle" fill={MUTED} fontSize={8.5}>
        {fixed ? 'FIXED CAPACITY' : 'LIFO'}
      </text>
    </>
  )
}

function NodeView({
  node,
  actionByEdge,
  active,
}: {
  node: LayoutNode
  actionByEdge: Map<string, FlowAction>
  active: boolean
}) {
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      opacity={active ? 1 : 0.5}
      style={{ transition: 'opacity 120ms ease' }}
    >
      <ThreadShape node={node} />
      <MsgqShape node={node} />
      <FifoShape node={node} />
      <VerticalStackShape node={node} />
      {node.ports.map((port) => {
        const action = actionByEdge.get(port.edgeId)
        return (
          <g key={port.id}>
            <circle
              cx={port.x + port.width / 2}
              cy={port.y + port.height / 2}
              r={4.5}
              fill={action ? flowActionColor(action) : '#cbd5e1'}
              stroke={PANEL}
              strokeWidth={2}
            />
            <title>{portRoleLabel(port.role)}</title>
          </g>
        )
      })}
      <title>
        {nodeKindLabel(node)} · {node.label}
        {node.kind === 'thread'
          ? ''
          : ` · depth ${node.depth.toLocaleString('en-US')}${node.capacity == null ? '' : ` of ${node.capacity.toLocaleString('en-US')}`}`}
      </title>
    </g>
  )
}

function EdgeView({
  edge,
  active,
  onHover,
}: {
  edge: LayoutEdge
  active: boolean
  onHover: (id: string | null) => void
}) {
  const path = roundedOrthogonalPath(edge.points)
  const color = flowActionColor(edge.action)
  return (
    <g
      opacity={active ? 1 : 0.16}
      style={{ transition: 'opacity 120ms ease' }}
      onPointerEnter={() => onHover(edge.id)}
      onPointerLeave={() => onHover(null)}
    >
      <path d={path} fill="none" stroke={PANEL} strokeWidth={8} strokeLinecap="round" />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={active ? 2.8 : 2}
        strokeLinecap="round"
        markerEnd={`url(#${markerId(edge.action)})`}
        vectorEffect="non-scaling-stroke"
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
      <title>{flowActionLabel(edge.action)}</title>
    </g>
  )
}

function GraphSvg({ layout }: { layout: QueueGraphLayout }) {
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const edgeById = useMemo(() => new Map(layout.edges.map((edge) => [edge.id, edge])), [layout])
  const actionByEdge = useMemo(
    () => new Map(layout.edges.map((edge) => [edge.id, edge.action])),
    [layout],
  )
  const highlightedNodes = useMemo(() => {
    if (!hoveredEdge) return null
    const edge = edgeById.get(hoveredEdge)
    return edge ? new Set([edge.sourceNodeId, edge.targetNodeId]) : null
  }, [edgeById, hoveredEdge])

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label="Synthetic Zephyr data-flow topology"
      className="block h-auto w-full"
    >
      <defs>
        <pattern id="mock-grid" width={24} height={24} patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="#243044" strokeWidth={0.5} opacity={0.42} />
        </pattern>
        {(['put', 'put-front', 'get', 'push', 'pop'] as const).map((action) => (
          <marker
            key={action}
            id={markerId(action)}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={8}
            markerHeight={8}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10Z" fill={flowActionColor(action)} />
          </marker>
        ))}
      </defs>
      <rect width={layout.width} height={layout.height} rx={18} fill={PANEL} />
      <rect width={layout.width} height={layout.height} rx={18} fill="url(#mock-grid)" />
      <g>
        {layout.edges.map((edge) => (
          <EdgeView
            key={edge.id}
            edge={edge}
            active={hoveredEdge == null || hoveredEdge === edge.id}
            onHover={setHoveredEdge}
          />
        ))}
      </g>
      <g>
        {layout.nodes.map((node) => (
          <NodeView
            key={node.id}
            node={node}
            actionByEdge={actionByEdge}
            active={highlightedNodes == null || highlightedNodes.has(node.id)}
          />
        ))}
      </g>
    </svg>
  )
}

function LegendItem({ action, label }: { action: FlowAction; label: string }) {
  return (
    <span className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="h-0.5 w-7 rounded-full" style={{ backgroundColor: flowActionColor(action) }} />
      {label}
    </span>
  )
}

export function QueueGraphMock() {
  const [largeCapacities, setLargeCapacities] = useState(false)
  const [layout, setLayout] = useState<QueueGraphLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const graph = largeCapacities ? queueGraphLargeCapacityMock : queueGraphMock

  useEffect(() => {
    let current = true
    setLayout(null)
    setError(null)
    layoutSemanticGraph(graph)
      .then((next) => {
        if (current) setLayout(next)
      })
      .catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      current = false
    }
  }, [graph])

  const issues = layout ? validateQueueGraphLayout(layout) : []

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-sky-300">
                Synthetic topology
              </span>
              <span
                className={
                  issues.length === 0
                    ? 'rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-300'
                    : 'rounded-full border border-rose-400/25 bg-rose-400/10 px-2 py-1 text-[10px] text-rose-300'
                }
              >
                {layout ? `${issues.length} geometry issues` : 'layout running'}
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">IPC data-flow layout study</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Automatic layered placement, fixed semantic ports, orthogonal routes, and distinct
              bounded/unbounded object shapes.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2">
            <LegendItem action="put" label="put / push" />
            <LegendItem action="put-front" label="put front" />
            <LegendItem action="get" label="get / pop" />
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-slate-500">
            Small capacities show exact slots; large capacities use a continuous proportional gauge.
            Exact values remain available in each object tooltip.
          </p>
          <div
            className="flex rounded-lg border border-slate-800 bg-slate-900/70 p-1 text-[11px]"
            aria-label="Capacity scenario"
          >
            <button
              type="button"
              data-testid="capacity-typical"
              aria-pressed={!largeCapacities}
              className={
                !largeCapacities
                  ? 'rounded-md bg-slate-700 px-3 py-1.5 text-slate-100'
                  : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
              }
              onClick={() => setLargeCapacities(false)}
            >
              Typical capacity
            </button>
            <button
              type="button"
              data-testid="capacity-large"
              aria-pressed={largeCapacities}
              className={
                largeCapacities
                  ? 'rounded-md bg-violet-500/25 px-3 py-1.5 text-violet-200'
                  : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
              }
              onClick={() => setLargeCapacities(true)}
            >
              Large-capacity stress
            </button>
          </div>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#080d18] shadow-2xl shadow-black/30">
          {error ? (
            <div className="p-8 text-sm text-rose-300">{error}</div>
          ) : layout ? (
            <GraphSvg layout={layout} />
          ) : (
            <div className="grid h-96 place-items-center text-sm text-slate-500">Computing layout…</div>
          )}
        </section>

        <footer className="flex flex-wrap justify-between gap-3 text-[11px] text-slate-500">
          <span>Hover a route to isolate its endpoints.</span>
          <span>Mock data only · live CTF integration intentionally deferred.</span>
        </footer>
      </div>
    </main>
  )
}
