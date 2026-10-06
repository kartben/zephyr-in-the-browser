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
import type { ElkPoint } from 'elkjs/lib/elk-api'
import {
  flowActionColor,
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
import { STATE_COLOR } from '@/ctf'
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
/** A press that moves less than this far is a click on what is under it, not a pan. */
const CLICK_SLOP_PX = 4
const FOCUS_RING = '#7dd3fc'
/** A thread blocked on an object: the Timeline's blocked red. */
export const WAIT_COLOR = STATE_COLOR.blk
export const HOLD_COLOR = '#e2e8f0'

/**
 * Semaphores, mutexes and condvars each get a colour of their own, apart from
 * the grey of queues, the blue of threads and the purple of interrupts, and a
 * badge: a padlock, a signal lamp, a bell.
 */
export const SYNC_STYLE: Record<
  'sem' | 'mutex' | 'condvar',
  { stroke: string; fill: string; badge: string; tint: string; name: string }
> = {
  mutex: { stroke: '#fbbf24', fill: '#1f1807', badge: '#3a2c0a', tint: '#fde68a', name: 'mutex' },
  sem: { stroke: '#34d399', fill: '#071f18', badge: '#0c3527', tint: '#a7f3d0', name: 'semaphore' },
  condvar: { stroke: '#a78bfa', fill: '#16112c', badge: '#271d4a', tint: '#ddd6fe', name: 'condvar' },
}

/** Room for a name in a sync object's pill, in characters. */
const SYNC_LABEL_CHARS = 17
const WAIT_MARKER = 'ipc-arrow-waits'
const WAIT_MARKER_START = 'ipc-arrow-waits-start'
const ARROW_ACTIONS = ['put', 'put-front', 'get', 'push', 'pop', 'give', 'take', 'signal', 'wait'] as const

const VERB: Record<FlowAction, string> = {
  put: 'puts into',
  'put-front': 'puts at the front of',
  get: 'gets from',
  push: 'pushes onto',
  pop: 'pops from',
  give: 'gives',
  take: 'takes',
  signal: 'signals',
  wait: 'waits on',
  lock: 'locks',
}

type DisplayLayoutNode = LayoutNode & {
  batchMaxDepth?: number
  batchDurationMs?: number
  batchSequence?: number
  owner?: string | null
  lockDepth?: number
  waiterLabels?: string[]
  mutexLabel?: string | null
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
    case 'object-in':
      return 'in'
    case 'object-out':
      return 'out'
  }
}

function nodeKindLabel(node: LayoutNode): string {
  if (node.kind === 'thread') return 'thread'
  if (node.kind === 'isr') return 'interrupt context'
  if (node.kind === 'msgq') return 'message queue'
  if (node.kind === 'fifo') return 'fifo'
  if (node.kind === 'queue') return 'queue'
  if (node.kind === 'lifo') return 'lifo'
  if (node.kind === 'sem') return 'semaphore'
  if (node.kind === 'mutex') return 'mutex'
  if (node.kind === 'condvar') return 'condition variable'
  return 'fixed stack'
}

function heldText(node: DisplayLayoutNode): string {
  if (node.owner == null) return 'free'
  const depth = (node.lockDepth ?? 1) > 1 ? ` ×${node.lockDepth}` : ''
  return node.owner === '' ? `held since before the trace${depth}` : `held by ${node.owner}${depth}`
}

/** Everything a node says, in words, for its tooltip and assistive tech. */
function nodeTitle(node: DisplayLayoutNode): string {
  const head = `${nodeKindLabel(node)} · ${node.label}`
  if (isActorNode(node)) return head
  if (node.kind === 'sem' || node.kind === 'mutex' || node.kind === 'condvar') {
    const parts = [head]
    if (node.kind === 'mutex') parts.push(heldText(node))
    const waiters = node.waiterLabels ?? []
    parts.push(waiters.length > 0 ? `waiting: ${waiters.join(', ')}` : 'nobody waiting')
    if (node.mutexLabel) parts.push(`with ${node.mutexLabel}`)
    return parts.join(' · ')
  }
  if (!('depth' in node)) return head
  return `${head} · depth ${node.depth.toLocaleString('en-US')}${node.capacity == null ? '' : ` of ${node.capacity.toLocaleString('en-US')}`}`
}

/** A padlock, its body centred on (x, y). */
function LockGlyph({
  x,
  y,
  color,
  scale = 1,
  open = false,
}: {
  x: number
  y: number
  color: string
  scale?: number
  /** The shackle lifted out of the body: a free mutex. */
  open?: boolean
}) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      <path
        d={open ? 'M-3.5 -3V-6a3.5 3.5 0 0 1 7 0V-4.5' : 'M-3.5 -1V-4a3.5 3.5 0 0 1 7 0V-1'}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
      />
      <rect x={-5.5} y={-1.5} width={11} height={8} rx={1.8} fill={color} />
    </g>
  )
}

/** A signal lamp: a semaphore is the railway's signal before it is the kernel's. */
function LampGlyph({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x={-4} y={-7} width={8} height={14} rx={3} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={0} cy={-2.8} r={1.7} fill={color} />
      <circle cx={0} cy={2.8} r={1.7} fill={color} fillOpacity={0.45} />
    </g>
  )
}

/** A bell: a condvar wakes whoever waits on it. */
function BellGlyph({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <path d="M-5.5 3.5h11l-1.6-2.2V-1.5a3.9 3.9 0 0 0-7.8 0v2.8z" fill={color} />
      <circle cx={0} cy={5.4} r={1.4} fill={color} />
    </g>
  )
}

function fitLabel(label: string): string {
  return label.length > SYNC_LABEL_CHARS ? `${label.slice(0, SYNC_LABEL_CHARS - 1)}…` : label
}

function ActorShape({ node }: { node: LayoutNode }) {
  if (node.kind !== 'thread' && node.kind !== 'isr') return null
  const isr = node.kind === 'isr'
  // "priority 3 (inherited, base 9)" is too long for one line of the card:
  // the part in brackets gets its own, in the colour of the mutex lending it,
  // below the others, which stay put as boosts come and go.
  const [, detail = node.detail ?? (isr ? 'interrupt context' : 'thread'), note] =
    /^(.*) \((.*)\)$/.exec(node.detail ?? '') ?? []
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
        {detail}
      </text>
      {note && (
        <text x={35} y={node.height / 2 + 23} fill={SYNC_STYLE.mutex.tint} fontSize={8.5}>
          {note}
        </text>
      )}
    </>
  )
}

/**
 * A queue's box, laid along the way the graph runs: tail where its entries
 * arrive and head where its exits leave, left to right or top to bottom.
 */
function queueFrame(node: DisplayLayoutNode, vertical: boolean) {
  const trackStart = vertical ? 48 : 24
  const trackLength = vertical ? node.height - 74 : node.width - 48
  const trackX = vertical ? node.width / 2 - 12 : trackStart
  const trackY = vertical ? trackStart : node.height / 2 - 2
  return {
    trackLength,
    /** A run of the track, from `start` along it for `length`, 24 across. */
    cell: (start: number, length: number) =>
      vertical
        ? { x: trackX, y: trackY + start, width: 24, height: length }
        : { x: trackX + start, y: trackY, width: length, height: 24 },
    /** Where the title and the kind line go. */
    title: { x: vertical ? 14 : 18, y: vertical ? 22 : 24 },
    info: vertical
      ? { x: 14, y: 37, anchor: 'start' as const }
      : { x: node.width - 18, y: 24, anchor: 'end' as const },
    tail: vertical
      ? { x: trackX + 32, y: trackY + 9, anchor: 'start' as const }
      : { x: 18, y: node.height - 12, anchor: 'start' as const },
    head: vertical
      ? { x: trackX + 32, y: trackY + trackLength - 2, anchor: 'start' as const }
      : { x: node.width - 18, y: node.height - 12, anchor: 'end' as const },
  }
}

function QueueLabels({ frame }: { frame: ReturnType<typeof queueFrame> }) {
  return (
    <>
      <text x={frame.tail.x} y={frame.tail.y} textAnchor={frame.tail.anchor} fill={MUTED} fontSize={8.5}>
        TAIL
      </text>
      <text x={frame.head.x} y={frame.head.y} textAnchor={frame.head.anchor} fill={MUTED} fontSize={8.5}>
        HEAD
      </text>
    </>
  )
}

function MsgqShape({ node, vertical }: { node: DisplayLayoutNode; vertical: boolean }) {
  if (node.kind !== 'msgq') return null
  const cap = Math.max(1, node.capacity ?? 1)
  const showExactSlots = node.capacity != null && node.capacity <= 10
  const visibleSlots = showExactSlots ? cap : 0
  const gap = 4
  const frame = queueFrame(node, vertical)
  const trackLength = frame.trackLength
  const slotLength = showExactSlots ? (trackLength - gap * (visibleSlots - 1)) / visibleSlots : 0
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
      <text x={frame.title.x} y={frame.title.y} fill={TEXT} fontSize={13} fontWeight={700}>
        {node.label}
      </text>
      <text x={frame.info.x} y={frame.info.y} textAnchor={frame.info.anchor} fill={MUTED} fontSize={9.5}>
        msgq · {compactCapacity(node.depth, node.capacity)}
      </text>
      {showExactSlots ? (
        Array.from({ length: visibleSlots }, (_, index) => {
          const filled = index < node.depth
          const inBatch = !filled && index < batchMax
          return (
            <rect
              key={`${index}:${inBatch ? node.batchSequence : 'steady'}`}
              {...frame.cell(index * (slotLength + gap), slotLength)}
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
            {...frame.cell(0, trackLength)}
            rx={6}
            fill="#09111f"
            stroke="#27364d"
            strokeWidth={0.8}
          />
          {batchFillFraction > fillFraction && (
            <rect
              key={`batch:${node.batchSequence}`}
              {...frame.cell(0, Math.max(1, trackLength * batchFillFraction))}
              rx={Math.min(6, Math.max(0.5, (trackLength * batchFillFraction) / 2))}
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
              {...frame.cell(0, Math.max(1, trackLength * fillFraction))}
              rx={Math.min(6, Math.max(0.5, (trackLength * fillFraction) / 2))}
              fill="#38bdf8"
              fillOpacity={0.62}
              stroke="#7dd3fc"
              strokeWidth={0.8}
            />
          )}
        </>
      )}
      <QueueLabels frame={frame} />
    </>
  )
}

function FifoShape({ node, vertical }: { node: DisplayLayoutNode; vertical: boolean }) {
  if (node.kind !== 'fifo' && node.kind !== 'queue') return null
  const frame = queueFrame(node, vertical)
  const itemCount = Math.min(vertical ? 4 : 5, Math.max(1, node.depth))
  const pitch = vertical ? 26 : 29
  // The items sit on the track's centre line.
  const line = vertical
    ? { x1: node.width / 2, y1: 50, x2: node.width / 2, y2: node.height - 20 }
    : { x1: 42, y1: node.height / 2 + 6, x2: node.width - 42, y2: node.height / 2 + 6 }
  const item = (index: number) =>
    vertical
      ? { cx: node.width / 2, cy: 62 + index * pitch }
      : { cx: 58 + index * pitch, cy: node.height / 2 + 6 }
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
      <text x={frame.title.x} y={frame.title.y} fill={TEXT} fontSize={13} fontWeight={700}>
        {node.label}
      </text>
      <text x={frame.info.x} y={frame.info.y} textAnchor={frame.info.anchor} fill={MUTED} fontSize={9.5}>
        {node.kind} · depth {node.depth}
      </text>
      <line {...line} stroke="#334155" strokeWidth={2} />
      {Array.from({ length: itemCount }, (_, index) => {
        const { cx, cy } = item(index)
        return (
          <g key={index}>
            <circle cx={cx} cy={cy} r={10} fill="#172b3d" stroke="#7dd3fc" strokeWidth={1} />
            <circle cx={cx} cy={cy} r={3} fill="#7dd3fc" fillOpacity={0.75} />
          </g>
        )
      })}
      <QueueLabels frame={frame} />
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

/**
 * A pill much smaller than a queue's box: its kind's colour and badge, its
 * name, and one line of state. Threads waiting on it show as a red count on
 * its corner; who they are is in the tooltip and on the dashed routes.
 */
function SyncShape({ node }: { node: DisplayLayoutNode }) {
  if (node.kind !== 'sem' && node.kind !== 'mutex' && node.kind !== 'condvar') return null
  const style = SYNC_STYLE[node.kind]
  const waiting = node.waiterLabels?.length ?? 0
  const held = node.kind === 'mutex' && node.owner != null
  const status =
    node.kind === 'mutex'
      ? { text: node.owner === '' ? 'held' : heldText(node), color: held ? style.tint : MUTED }
      : node.kind === 'condvar' && node.mutexLabel
        ? { text: `with ${fitLabel(node.mutexLabel)}`, color: MUTED }
        : { text: style.name, color: MUTED }
  const cy = node.height / 2
  return (
    <>
      <rect
        width={node.width}
        height={node.height}
        rx={Math.min(node.height / 2, 24)}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={1.5}
      />
      <circle cx={24} cy={cy} r={13} fill={style.badge} stroke={style.stroke} strokeWidth={1} />
      {node.kind === 'mutex' ? (
        <LockGlyph x={24} y={cy - 0.5} color={style.stroke} open={!held} />
      ) : node.kind === 'sem' ? (
        <LampGlyph x={24} y={cy} color={style.stroke} />
      ) : (
        <BellGlyph x={24} y={cy - 0.5} color={style.stroke} />
      )}
      <text x={44} y={cy - 3} fill={TEXT} fontSize={12.5} fontWeight={700}>
        {fitLabel(node.label)}
      </text>
      <text x={44} y={cy + 12} fill={status.color} fontSize={9.5}>
        {status.text}
      </text>
      {waiting > 0 && (
        <g>
          <circle cx={node.width - 6} cy={6} r={9} fill={WAIT_COLOR} stroke={PANEL} strokeWidth={2} />
          <text
            x={node.width - 6}
            y={9.5}
            textAnchor="middle"
            fill="#fff"
            fontSize={10}
            fontWeight={700}
          >
            {waiting}
          </text>
        </g>
      )}
    </>
  )
}

function NodeView({
  node,
  actionByEdge,
  active,
  focused,
  clickable,
  vertical,
}: {
  node: DisplayLayoutNode
  actionByEdge: Map<string, FlowAction>
  active: boolean
  focused: boolean
  clickable: boolean
  /** The graph runs top to bottom. */
  vertical: boolean
}) {
  return (
    <g
      data-node-id={node.id}
      transform={`translate(${node.x},${node.y})`}
      opacity={active ? 1 : 0.5}
      style={{ transition: 'opacity 120ms ease', cursor: clickable ? 'pointer' : undefined }}
    >
      {focused && (
        <rect
          x={-6}
          y={-6}
          width={node.width + 12}
          height={node.height + 12}
          rx={17}
          fill="none"
          stroke={FOCUS_RING}
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
      )}
      <ActorShape node={node} />
      <MsgqShape node={node} vertical={vertical} />
      <FifoShape node={node} vertical={vertical} />
      <VerticalStackShape node={node} />
      <SyncShape node={node} />
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
      <title>{nodeTitle(node)}</title>
    </g>
  )
}

/** Where the lock mark of a held route goes: a little way along it from the thread. */
function lockMarkAt(points: ElkPoint[], fromStart: boolean): ElkPoint {
  const a = fromStart ? points[0]! : points[points.length - 1]!
  const b = fromStart ? points[1] ?? a : points[points.length - 2] ?? a
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  const along = Math.min(18, length / 2)
  return { x: a.x + (dx / length) * along, y: a.y + (dy / length) * along }
}

function EdgeView({
  edge,
  active,
  activity,
  state,
  title,
  onHover,
}: {
  edge: LayoutEdge
  active: boolean
  activity?: QueueGraphEdgeActivity
  state?: QueueGraphEdgeState
  title: string
  onHover: (id: string | null) => void
}) {
  const path = roundedOrthogonalPath(edge.points)
  const waits = state === 'waits'
  const holds = state === 'holds'
  const objectAtEnd = edge.targetNodeId === edge.objectNodeId
  const color = waits ? WAIT_COLOR : holds ? HOLD_COLOR : flowActionColor(edge.action)
  const opacity = active ? (state || activity?.hot ? 1 : activity?.warm ? 0.82 : 0.58) : 0.12
  // A wait points at what it waits for, whichever way its route runs. A lock
  // route has no arrow: its users both take the mutex and give it back.
  const markerEnd = waits
    ? objectAtEnd
      ? `url(#${WAIT_MARKER})`
      : undefined
    : edge.action === 'lock'
      ? undefined
      : `url(#${markerId(edge.action)})`
  const lockMark = holds ? lockMarkAt(edge.points, objectAtEnd) : null
  return (
    <g
      opacity={opacity}
      style={{ transition: 'opacity 120ms ease' }}
      onPointerEnter={() => onHover(edge.id)}
      onPointerLeave={() => onHover(null)}
    >
      <path d={path} fill="none" stroke={PANEL} strokeWidth={holds ? 10 : 8} strokeLinecap="round" />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={holds ? 4.4 : activity?.hot ? 4.2 : active ? 2.8 : 2}
        strokeLinecap="round"
        strokeDasharray={waits ? '7 5' : undefined}
        markerEnd={markerEnd}
        markerStart={waits && !objectAtEnd ? `url(#${WAIT_MARKER_START})` : undefined}
        vectorEffect="non-scaling-stroke"
      />
      {lockMark && (
        <g>
          <circle cx={lockMark.x} cy={lockMark.y} r={8.5} fill={PANEL} stroke={HOLD_COLOR} strokeWidth={1.2} />
          <LockGlyph x={lockMark.x} y={lockMark.y - 1} color={HOLD_COLOR} scale={0.75} />
        </g>
      )}
      <path d={path} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
      <title>
        {title}
        {activity?.count ? ` · ${activity.count.toLocaleString('en-US')} recent` : ''}
      </title>
    </g>
  )
}

/**
 * "sensor_imu puts into sensor_q" for what a route has carried, and "storage
 * holds bus_mutex" or "aggregator is waiting for bus_mutex" for what holds now.
 */
function edgeTitle(
  edge: LayoutEdge,
  labelById: ReadonlyMap<string, string>,
  state: QueueGraphEdgeState | undefined,
): string {
  const actorId = edge.objectNodeId === edge.targetNodeId ? edge.sourceNodeId : edge.targetNodeId
  const verb =
    state === 'holds'
      ? 'holds'
      : state === 'waits'
        ? edge.action === 'wait'
          ? 'is waiting on'
          : 'is waiting for'
        : VERB[edge.action]
  return `${labelById.get(actorId) ?? '?'} ${verb} ${labelById.get(edge.objectNodeId) ?? '?'}`
}

export interface QueueGraphNodeState {
  label?: string
  detail?: string
  depth?: number
  capacity?: number | null
  batchMaxDepth?: number
  batchDurationMs?: number
  batchSequence?: number
  /** mutex: who holds it, '' when it was held before the trace began, or null when free. */
  owner?: string | null
  /** mutex: how many times the owner holds it. */
  lockDepth?: number
  /** semaphore, mutex, condvar: the threads blocked on it now, longest waiting first. */
  waiterLabels?: string[]
  /** condvar: the mutex its waiters give up while they wait. */
  mutexLabel?: string | null
}

/** A route as it stands now: a mutex held along it, or a thread blocked along it. */
export type QueueGraphEdgeState = 'holds' | 'waits'

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
  edgeState,
  packets = [],
  ariaLabel = 'Zephyr IPC data-flow topology',
  focusedNodeId = null,
  onNodeClick,
  onClearFocus,
}: {
  layout: QueueGraphLayout
  nodeState?: ReadonlyMap<string, QueueGraphNodeState>
  edgeActivity?: ReadonlyMap<string, QueueGraphEdgeActivity>
  edgeState?: ReadonlyMap<string, QueueGraphEdgeState>
  packets?: QueueGraphPacket[]
  ariaLabel?: string
  /** Node to ring as the one the graph is focused on. */
  focusedNodeId?: string | null
  /** A node was clicked (pressed and released without panning). */
  onNodeClick?: (nodeId: string) => void
  /** Escape was pressed in the graph while it is focused on a node. */
  onClearFocus?: () => void
}) {
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [viewport, setViewport] = useState<GraphViewportSize>({ width: 0, height: 0 })
  const [camera, setCamera] = useState<GraphCamera | null>(null)
  const [dragging, setDragging] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const previousViewportRef = useRef<GraphViewportSize | null>(null)
  const previousLayoutRef = useRef(layout)
  const dragRef = useRef<{
    pointerId: number
    x: number
    y: number
    startX: number
    startY: number
    /** The node pressed on, if any: a release close by clicks it. */
    nodeId: string | null
  } | null>(null)
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
  const labelById = useMemo(
    () => new Map(displayNodes.map((node) => [node.id, node.label])),
    [displayNodes],
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
      // Focusable, though not in the tab order, so Escape reaches the graph
      // once the reader has clicked into it.
      tabIndex={-1}
      className="group relative h-[clamp(16rem,42vh,28rem)] min-h-64 overflow-hidden bg-[#080d18] outline-none"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || focusedNodeId === null || !onClearFocus) return
        event.stopPropagation()
        onClearFocus()
      }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${Math.max(1, viewport.width)} ${Math.max(1, viewport.height)}`}
        role="img"
        aria-label={`${ariaLabel}. Drag to pan and use the mouse wheel to zoom.${onNodeClick ? ' Click a thread or an object to focus on it.' : ''}`}
        className={cn(
          'block size-full touch-none select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          window.getSelection()?.removeAllRanges()
          hostRef.current?.focus({ preventScroll: true })
          // Read before capturing: from here on every event targets the svg.
          const pressed = (event.target as Element).closest?.('[data-node-id]')
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* ignore */
          }
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            nodeId: pressed?.getAttribute('data-node-id') ?? null,
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
          const drag = dragRef.current
          if (drag?.pointerId !== event.pointerId) return
          dragRef.current = null
          setDragging(false)
          if (
            drag.nodeId &&
            onNodeClick &&
            Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CLICK_SLOP_PX
          ) {
            onNodeClick(drag.nodeId)
          }
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
          {ARROW_ACTIONS.map((action) => (
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
          {[WAIT_MARKER, WAIT_MARKER_START].map((id) => (
            <marker
              key={id}
              id={id}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={9}
              markerHeight={9}
              markerUnits="userSpaceOnUse"
              orient={id === WAIT_MARKER ? 'auto' : 'auto-start-reverse'}
            >
              <path d="M0 0L10 5L0 10Z" fill={WAIT_COLOR} />
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
                state={edgeState?.get(edge.id)}
                title={edgeTitle(edge, labelById, edgeState?.get(edge.id))}
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
                focused={node.id === focusedNodeId}
                clickable={onNodeClick != null}
                vertical={layout.direction === 'DOWN'}
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
        Wheel to zoom · drag to pan{onNodeClick ? ' · click to focus' : ''}
      </span>
    </div>
  )
}
