import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import {
  capacityFillFraction,
  compactCapacity,
  compactCount,
} from '@/components/queueGraph/display'
import { roundedOrthogonalPath } from '@/components/queueGraph/geometry'
import {
  type LayoutEdge,
  type LayoutNode,
  type QueueGraphLayout,
} from '@/components/queueGraph/layout'
import {
  flowActionColor,
  flowActionLabel,
  isActorNode,
  type FlowAction,
  type PortRole,
} from '@/components/queueGraph/model'
import {
  fitGraphCamera,
  resizeGraphCamera,
  zoomGraphCamera,
  type GraphCamera,
  type GraphViewportSize,
} from '@/components/queueGraph/viewport'
import { cn } from '@/lib/utils'

const OBJECT_FILL = '#101a2b'
const OBJECT_STROKE = '#7c8ba1'
const THREAD_FILL = '#10203a'
const THREAD_STROKE = '#60a5fa'
const ISR_FILL = '#241338'
const ISR_STROKE = '#c084fc'
const TEXT = '#f1f5f9'
const MUTED = '#94a3b8'
const PANEL = '#080d18'
const BUTTON_ZOOM_IN = 1.25
const BUTTON_ZOOM_OUT = 1 / BUTTON_ZOOM_IN
const MIN_FIT_SCALE_FACTOR = 0.35
const MAX_SCALE = 4

type DisplayLayoutNode = LayoutNode & {
  batchMinDepth?: number
  batchMaxDepth?: number
  batchDurationMs?: number
  batchSequence?: number
}

function batchDepthLabel(node: DisplayLayoutNode): string {
  if (node.batchMinDepth == null || node.batchMaxDepth == null) return ''
  const range =
    node.batchMinDepth === node.batchMaxDepth
      ? compactCount(node.batchMinDepth)
      : `${compactCount(node.batchMinDepth)}–${compactCount(node.batchMaxDepth)}`
  return ` · batch ${range}`
}

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
    case 'actor-in':
      return 'flow in'
    case 'actor-out':
      return 'flow out'
  }
}

function nodeKindLabel(node: LayoutNode): string {
  if (node.kind === 'thread') return 'thread'
  if (node.kind === 'isr') return 'interrupt context'
  if (node.kind === 'msgq') return 'message queue'
  if (node.kind === 'fifo') return 'fifo'
  if (node.kind === 'queue') return 'queue'
  if (node.kind === 'lifo') return 'lifo'
  return 'fixed stack'
}

function ActorShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'thread' && node.kind !== 'isr') return null
  const isr = node.kind === 'isr'
  const fill = isr ? ISR_FILL : THREAD_FILL
  const stroke = isr ? ISR_STROKE : THREAD_STROKE
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        fill={fill}
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray={isr ? '6 4' : undefined}
      />
      {isr ? (
        <path
          d={`M17 ${node.height / 2 - 9}L25 ${node.height / 2 - 2}L20 ${node.height / 2 - 2}L24 ${node.height / 2 + 9}L15 ${node.height / 2 + 1}L20 ${node.height / 2 + 1}Z`}
          fill={ISR_STROKE}
          fillOpacity={0.95}
        />
      ) : (
        <circle cx={20} cy={node.height / 2} r={6} fill={THREAD_STROKE} fillOpacity={0.9} />
      )}
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
        {node.detail ?? (isr ? 'interrupt context' : 'thread')}
      </text>
    </>
  )
}

function MsgqShape({ node }: { node: DisplayLayoutNode }) {
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
  const batchMax = Math.max(node.depth, node.batchMaxDepth ?? node.depth)
  const batchFillFraction = capacityFillFraction(batchMax, cap)
  const batchDuration = `${node.batchDurationMs ?? 420}ms`
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
        {batchDepthLabel(node)}
      </text>
      {showExactSlots ? (
        Array.from({ length: visibleSlots }, (_, index) => {
          const filled = index < node.depth
          const inBatch = !filled && index < batchMax
          return (
            <rect
              key={`${index}:${inBatch ? node.batchSequence : 'steady'}`}
              x={trackX + index * (slotW + gap)}
              y={trackY}
              width={slotW}
              height={24}
              rx={4}
              fill={filled || inBatch ? '#38bdf8' : '#09111f'}
              fillOpacity={filled ? 0.62 : inBatch ? 0.3 : 1}
              stroke={filled || inBatch ? '#7dd3fc' : '#27364d'}
              strokeWidth={0.8}
            >
              {inBatch && (
                <animate
                  attributeName="fill-opacity"
                  values="0.3;0"
                  dur={batchDuration}
                  fill="freeze"
                />
              )}
            </rect>
          )
        })
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
          {batchFillFraction > fillFraction && (
            <rect
              key={`batch:${node.batchSequence}`}
              x={trackX}
              y={trackY}
              width={Math.max(1, trackW * batchFillFraction)}
              height={24}
              rx={Math.min(6, Math.max(0.5, (trackW * batchFillFraction) / 2))}
              fill="#38bdf8"
              fillOpacity={0.3}
              stroke="#7dd3fc"
              strokeWidth={0.8}
            >
              <animate
                attributeName="fill-opacity"
                values="0.3;0"
                dur={batchDuration}
                fill="freeze"
              />
            </rect>
          )}
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

function FifoShape({ node }: { node: DisplayLayoutNode }) {
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
        {batchDepthLabel(node)}
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

function VerticalStackShape({ node }: { node: DisplayLayoutNode }) {
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
        {batchDepthLabel(node)}
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
  node: DisplayLayoutNode
  actionByEdge: Map<string, FlowAction>
  active: boolean
}) {
  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      opacity={active ? 1 : 0.5}
      style={{ transition: 'opacity 120ms ease' }}
    >
      <ActorShape node={node} />
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
        {isActorNode(node)
          ? ''
          : ` · depth ${node.depth.toLocaleString('en-US')}${node.capacity == null ? '' : ` of ${node.capacity.toLocaleString('en-US')}`}`}
      </title>
    </g>
  )
}

function EdgeView({
  edge,
  active,
  activity,
  onHover,
}: {
  edge: LayoutEdge
  active: boolean
  activity?: QueueGraphEdgeActivity
  onHover: (id: string | null) => void
}) {
  const path = roundedOrthogonalPath(edge.points)
  const color = flowActionColor(edge.action)
  const opacity = active ? (activity?.hot ? 1 : activity?.warm ? 0.82 : 0.58) : 0.12
  return (
    <g
      opacity={opacity}
      style={{ transition: 'opacity 120ms ease' }}
      onPointerEnter={() => onHover(edge.id)}
      onPointerLeave={() => onHover(null)}
    >
      <path d={path} fill="none" stroke={PANEL} strokeWidth={8} strokeLinecap="round" />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={activity?.hot ? 4.2 : active ? 2.8 : 2}
        strokeLinecap="round"
        markerEnd={`url(#${markerId(edge.action)})`}
        vectorEffect="non-scaling-stroke"
      />
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
      <title>
        {flowActionLabel(edge.action)}
        {activity?.count ? ` · ${activity.count.toLocaleString('en-US')} recent` : ''}
      </title>
    </g>
  )
}

export interface QueueGraphNodeState {
  label?: string
  detail?: string
  depth?: number
  capacity?: number | null
  batchMinDepth?: number
  batchMaxDepth?: number
  batchDurationMs?: number
  batchSequence?: number
}

export interface QueueGraphEdgeActivity {
  hot: boolean
  warm: boolean
  count: number
}

export interface QueueGraphPacket {
  id: string
  edgeId: string
  delayMs?: number
  durationMs?: number
}

export function QueueGraphCanvas({
  layout,
  nodeState,
  edgeActivity,
  packets = [],
  ariaLabel = 'Zephyr IPC data-flow topology',
}: {
  layout: QueueGraphLayout
  nodeState?: ReadonlyMap<string, QueueGraphNodeState>
  edgeActivity?: ReadonlyMap<string, QueueGraphEdgeActivity>
  packets?: QueueGraphPacket[]
  ariaLabel?: string
}) {
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [viewport, setViewport] = useState<GraphViewportSize>({ width: 0, height: 0 })
  const [camera, setCamera] = useState<GraphCamera | null>(null)
  const [dragging, setDragging] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const previousViewportRef = useRef<GraphViewportSize | null>(null)
  const previousLayoutRef = useRef(layout)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
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
  const displayNodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        const state = nodeState?.get(node.id)
        return state ? ({ ...node, ...state } as DisplayLayoutNode) : node
      }),
    [layout.nodes, nodeState],
  )

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => {
      const rect = host.getBoundingClientRect()
      setViewport({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0) return
    const previousViewport = previousViewportRef.current
    const layoutChanged = previousLayoutRef.current !== layout
    setCamera((current) => {
      if (!current || !previousViewport || layoutChanged) {
        return fitGraphCamera(layout, viewport)
      }
      return resizeGraphCamera(current, previousViewport, viewport)
    })
    previousViewportRef.current = viewport
    previousLayoutRef.current = layout
  }, [layout, viewport])

  const fitScale =
    viewport.width > 0 && viewport.height > 0
      ? fitGraphCamera(layout, viewport).scale
      : 1
  const minScale = fitScale * MIN_FIT_SCALE_FACTOR

  const zoomAt = useCallback(
    (factor: number, pivot = { x: viewport.width / 2, y: viewport.height / 2 }) => {
      setCamera((current) =>
        current
          ? zoomGraphCamera(current, factor, pivot, minScale, MAX_SCALE)
          : fitGraphCamera(layout, viewport),
      )
    },
    [layout, minScale, viewport],
  )

  const fitAll = useCallback(() => {
    if (viewport.width === 0 || viewport.height === 0) return
    setCamera(fitGraphCamera(layout, viewport))
  }, [layout, viewport])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const delta =
        event.deltaY *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? rect.height
            : 1)
      const factor = Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.0018)
      zoomAt(factor, {
        x: ((event.clientX - rect.left) / rect.width) * viewport.width,
        y: ((event.clientY - rect.top) / rect.height) * viewport.height,
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [viewport, zoomAt])

  const currentCamera = camera ?? fitGraphCamera(layout, {
    width: Math.max(1, viewport.width),
    height: Math.max(1, viewport.height),
  })
  const transform = `translate(${currentCamera.x} ${currentCamera.y}) scale(${currentCamera.scale})`
  const zoomPercent = Math.round((currentCamera.scale / fitScale) * 100)

  return (
    <div
      ref={hostRef}
      className="group relative h-[clamp(16rem,42vh,28rem)] min-h-64 overflow-hidden bg-[#080d18]"
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${Math.max(1, viewport.width)} ${Math.max(1, viewport.height)}`}
        role="img"
        aria-label={`${ariaLabel}. Drag to pan and use the mouse wheel to zoom.`}
        className={cn(
          'block size-full touch-none select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          window.getSelection()?.removeAllRanges()
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* ignore */
          }
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          drag.x = event.clientX
          drag.y = event.clientY
          setCamera((current) =>
            current ? { ...current, x: current.x + dx, y: current.y + dy } : current,
          )
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return
          dragRef.current = null
          setDragging(false)
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            /* ignore */
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null
          setDragging(false)
        }}
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
        <rect width="100%" height="100%" fill={PANEL} />
        <g transform={transform}>
          <rect width={layout.width} height={layout.height} rx={18} fill={PANEL} />
          <rect width={layout.width} height={layout.height} rx={18} fill="url(#mock-grid)" />
          <g>
            {layout.edges.map((edge) => (
              <EdgeView
                key={edge.id}
                edge={edge}
                active={hoveredEdge == null || hoveredEdge === edge.id}
                activity={edgeActivity?.get(edge.id)}
                onHover={setHoveredEdge}
              />
            ))}
          </g>
          <g pointerEvents="none">
            {packets.map((packet) => {
              const edge = edgeById.get(packet.edgeId)
              if (!edge) return null
              const path = roundedOrthogonalPath(edge.points)
              const duration = `${packet.durationMs ?? 360}ms`
              return (
                <circle
                  key={packet.id}
                  r={4}
                  fill={flowActionColor(edge.action)}
                  stroke="#f8fafc"
                  strokeWidth={0.8}
                >
                  <animateMotion
                    dur={duration}
                    begin={`${packet.delayMs ?? 0}ms`}
                    path={path}
                    fill="freeze"
                  />
                  <animate
                    attributeName="opacity"
                    values="1;1;0"
                    keyTimes="0;0.72;1"
                    dur={duration}
                    begin={`${packet.delayMs ?? 0}ms`}
                    fill="freeze"
                  />
                  <animate
                    attributeName="r"
                    values="4;4;2.5"
                    keyTimes="0;0.72;1"
                    dur={duration}
                    begin={`${packet.delayMs ?? 0}ms`}
                    fill="freeze"
                  />
                </circle>
              )
            })}
          </g>
          <g>
            {displayNodes.map((node) => (
              <NodeView
                key={node.id}
                node={node}
                actionByEdge={actionByEdge}
                active={highlightedNodes == null || highlightedNodes.has(node.id)}
              />
            ))}
          </g>
        </g>
      </svg>
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md border border-border/60 bg-slate-950/80 p-1 shadow-sm backdrop-blur-sm">
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => zoomAt(BUTTON_ZOOM_IN)}
          className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
        >
          <ZoomIn className="size-3.5" />
        </button>
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => zoomAt(BUTTON_ZOOM_OUT)}
          className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
        >
          <ZoomOut className="size-3.5" />
        </button>
        <button
          type="button"
          title="Reset to fit"
          aria-label="Reset topology to fit"
          onClick={fitAll}
          className="rounded p-0.5 text-muted-foreground touch-manipulation hover:bg-secondary hover:text-foreground"
        >
          <Maximize2 className="size-3.5" />
        </button>
        <span className="min-w-8 px-0.5 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
          {zoomPercent}%
        </span>
      </div>
      <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-slate-950/70 px-1.5 py-0.5 text-[9px] text-slate-500 opacity-0 transition-opacity group-hover:opacity-100">
        Wheel to zoom · drag to pan
      </span>
    </div>
  )
}
