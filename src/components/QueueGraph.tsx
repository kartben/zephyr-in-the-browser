import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IpcFilterBar } from '@/components/queueGraph/IpcFilterBar'
import {
  HOLD_COLOR,
  QueueGraphCanvas,
  SYNC_STYLE,
  WAIT_COLOR,
  type QueueGraphEdgeActivity,
  type QueueGraphPacket,
} from '@/components/queueGraph/QueueGraphCanvas'
import {
  flowActionColor,
  flowActionLabel,
  isActorNode,
  type FlowAction,
  type SemanticGraph,
} from '@/components/queueGraph/model'
import { useElementSize, useFittedLayout } from '@/components/queueGraph/useFittedLayout'
import {
  buildLiveQueueGraph,
  liveEdgeId,
  liveObjectNodeId,
  liveQueueNodeState,
  liveSyncView,
  queueDepthEnvelope,
  type LiveSync,
  type QueueDepthEnvelope,
} from '@/components/queueGraph/live'
import { cn } from '@/lib/utils'
import { advanceFlowCursor, type QueueFlowEvent } from '@/ctf/queueGraph'
import type { QueueSeries, Trace } from '@/ctf'
import * as ipcUi from '@/lib/ipcUi'

/** Complete inside the queue tab's 200 ms detail publication cadence. */
const PACKET_MS = 150
const PACKET_STAGGER_MS = 30
const PACKET_CLEANUP_MS = PACKET_MS + PACKET_STAGGER_MS + 80
const HOT_MS = 180
const WARM_MS = 900
const OCCUPANCY_ENVELOPE_MS = 420
const OCCUPANCY_CLEANUP_MS = OCCUPANCY_ENVELOPE_MS + 40
const MAX_PACKETS_PER_BURST = 3
const MAX_LIVE_PACKETS = 48

type EdgeActivityState = {
  count: number
  untilHot: number
  untilWarm: number
}

type DisplayedDepthEnvelope = QueueDepthEnvelope & { sequence: number }

function groupNewEvents(events: QueueFlowEvent[]): Map<string, QueueFlowEvent[]> {
  const grouped = new Map<string, QueueFlowEvent[]>()
  for (const event of events) {
    if (!event.ok || event.actor.kind === 'unknown') continue
    const id = liveEdgeId(event)
    const group = grouped.get(id) ?? []
    group.push(event)
    grouped.set(id, group)
  }
  return grouped
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** "5 objects", or "2 of 5 objects" while a filter hides some. */
function countLabel(shown: number, total: number, word: string): string {
  return shown === total ? plural(total, word) : `${shown} of ${plural(total, word)}`
}

type LegendEntry = {
  color: string
  label: string
  dashed?: boolean
  thick?: boolean
  /** A node kind, drawn as a small pill in its colours rather than as a route. */
  fill?: string
}

function LegendItem({ color, label, dashed = false, thick = false, fill }: LegendEntry) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {fill ? (
        <span
          className="h-2.5 w-4 rounded-full border"
          style={{ borderColor: color, backgroundColor: fill }}
        />
      ) : (
        <span
          className={cn('w-5 rounded-full', thick ? 'h-1' : 'h-0.5')}
          style={
            dashed
              ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 8px)` }
              : { backgroundColor: color }
          }
        />
      )}
      {label}
    </span>
  )
}

const IN_ACTIONS: FlowAction[] = ['put', 'push', 'give', 'signal']
const OUT_ACTIONS: FlowAction[] = ['get', 'pop', 'take', 'wait']

/**
 * One legend entry per colour and line style the graph's routes can be drawn
 * in, and none for the rest. A route is held or waited on only between a lock
 * or a wait and the release, so "holds" and "waits" follow the routes that can
 * be, not the latest event: otherwise they come and go while the guest runs.
 */
export function legendItems(graph: SemanticGraph): LegendEntry[] {
  const present = new Set(graph.edges.map((edge) => edge.action))
  const items: LegendEntry[] = []
  const ins = IN_ACTIONS.filter((action) => present.has(action))
  if (ins.length > 0) items.push({ color: flowActionColor('put'), label: ins.map(flowActionLabel).join(' / ') })
  if (present.has('put-front')) items.push({ color: flowActionColor('put-front'), label: 'put front' })
  const outs = OUT_ACTIONS.filter((action) => present.has(action))
  if (outs.length > 0) items.push({ color: flowActionColor('get'), label: outs.map(flowActionLabel).join(' / ') })
  if (present.has('lock')) {
    items.push({ color: flowActionColor('lock'), label: 'lock' })
    items.push({ color: HOLD_COLOR, label: 'holds', thick: true })
  }
  // A thread waits along a mutex's lock, a semaphore's take or a condvar's wait.
  if (present.has('lock') || present.has('take') || present.has('wait')) {
    items.push({ color: WAIT_COLOR, label: 'waits', dashed: true })
  }
  const kinds = new Set(graph.nodes.map((node) => node.kind))
  if (kinds.has('thread')) items.push({ color: '#60a5fa', fill: '#10203a', label: 'thread' })
  if (kinds.has('isr')) items.push({ color: '#c084fc', fill: '#241338', label: 'ISR' })
  for (const kind of ['mutex', 'sem', 'condvar'] as const) {
    if (kinds.has(kind)) {
      const style = SYNC_STYLE[kind]
      items.push({ color: style.stroke, fill: style.fill, label: style.name })
    }
  }
  return items
}

export function QueueGraph({
  tr,
  queues,
  flowEvents,
  eventCount,
  sync = null,
  priorities,
}: {
  tr: Trace
  queues: QueueSeries[]
  flowEvents: QueueFlowEvent[]
  eventCount: number
  /** Semaphores, mutexes and condvars, when the tab is open. */
  sync?: LiveSync | null
  /** Priorities the debugger read, for threads that never logged one. */
  priorities?: ReadonlyMap<number, number>
}) {
  const filter = useSyncExternalStore(ipcUi.subscribe, ipcUi.getSnapshot, ipcUi.getSnapshot)
  const live = useMemo(
    () => buildLiveQueueGraph(tr, queues, flowEvents, filter, sync),
    [tr, queues, flowEvents, eventCount, filter, sync],
  )
  const syncView = useMemo(
    () => (sync ? liveSyncView(tr, sync) : null),
    [tr, sync, eventCount],
  )
  // A tour names what to focus on; the node may only appear a little later.
  useEffect(() => {
    const name = filter.focusName
    if (name === null) return
    const node =
      live.nodes.find((n) => !isActorNode(n) && n.label === name) ??
      live.nodes.find((n) => n.label === name)
    if (node) ipcUi.resolveIpcFocus(node.id)
  }, [filter.focusName, live.nodes])
  const layoutRequest = useMemo(
    () => ({ key: live.topologyKey, graph: live.graph }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.topologyKey],
  )
  const frameRef = useRef<HTMLDivElement>(null)
  const frameSize = useElementSize(frameRef)
  const { layout, error: layoutError } = useFittedLayout(layoutRequest, frameSize)
  const [depthEnvelopes, setDepthEnvelopes] = useState(
    () => new Map<number, DisplayedDepthEnvelope>(),
  )
  const nodeState = useMemo(() => {
    const state = liveQueueNodeState(tr, queues, priorities)
    for (const [id, update] of syncView?.nodeState ?? []) {
      state.set(id, { ...state.get(id), ...update })
    }
    for (const [queueId, envelope] of depthEnvelopes) {
      const node = state.get(liveObjectNodeId(queueId))
      if (!node) continue
      node.batchMaxDepth = envelope.maxDepth
      node.batchDurationMs = OCCUPANCY_ENVELOPE_MS
      node.batchSequence = envelope.sequence
    }
    return state
  }, [tr, queues, eventCount, depthEnvelopes, syncView, priorities])
  const [clock, setClock] = useState(() => performance.now())
  const [packets, setPackets] = useState<QueueGraphPacket[]>([])
  const lastIndexRef = useRef(-1)
  const activityRef = useRef(new Map<string, EdgeActivityState>())
  const packetSequenceRef = useRef(0)
  const packetTimeoutsRef = useRef<number[]>([])
  const depthCursorRef = useRef<{
    t1: number
    depths: Map<number, number>
  } | null>(null)
  const occupancyTimeoutRef = useRef<number | undefined>(undefined)
  const occupancySequenceRef = useRef(0)

  useEffect(() => {
    const depths = new Map(
      queues.map((queue) => [queue.id, queue.samples.at(-1)?.depth ?? 0]),
    )
    const previous = depthCursorRef.current
    depthCursorRef.current = { t1: tr.t1, depths }

    if (occupancyTimeoutRef.current !== undefined) {
      window.clearTimeout(occupancyTimeoutRef.current)
      occupancyTimeoutRef.current = undefined
    }
    if (!previous || tr.t1 < previous.t1) {
      setDepthEnvelopes((current) => (current.size === 0 ? current : new Map()))
      return
    }

    const next = new Map<number, DisplayedDepthEnvelope>()
    const sequence = occupancySequenceRef.current++
    for (const queue of queues) {
      const envelope = queueDepthEnvelope(
        queue,
        previous.t1,
        previous.depths.get(queue.id) ?? 0,
      )
      if (
        envelope &&
        (envelope.minDepth !== envelope.finalDepth ||
          envelope.maxDepth !== envelope.finalDepth)
      ) {
        next.set(queue.id, { ...envelope, sequence })
      }
    }
    setDepthEnvelopes((current) => (next.size === 0 && current.size === 0 ? current : next))
    if (next.size > 0) {
      occupancyTimeoutRef.current = window.setTimeout(() => {
        setDepthEnvelopes((current) => (current.size === 0 ? current : new Map()))
        occupancyTimeoutRef.current = undefined
      }, OCCUPANCY_CLEANUP_MS)
    }
  }, [eventCount, queues, tr.t1])

  useEffect(() => {
    const advanced = advanceFlowCursor(live.flow, lastIndexRef.current)
    lastIndexRef.current = advanced.nextIndex
    const now = performance.now()

    if (advanced.kind === 'first') {
      for (const event of live.flow
        .filter((candidate) => candidate.ok && candidate.actor.kind !== 'unknown')
        .slice(-10)) {
        activityRef.current.set(liveEdgeId(event), {
          count: 1,
          untilHot: now + 350,
          untilWarm: now + WARM_MS,
        })
      }
      setClock(now)
      return
    }
    if (advanced.kind !== 'delta' || advanced.newest.length === 0) return

    const nextPackets: QueueGraphPacket[] = []
    for (const [edgeId, events] of groupNewEvents(advanced.newest)) {
      activityRef.current.set(edgeId, {
        count: events.length,
        untilHot: now + HOT_MS,
        untilWarm: now + WARM_MS,
      })
      const packetCount = Math.min(events.length, MAX_PACKETS_PER_BURST)
      for (let index = 0; index < packetCount; index++) {
        nextPackets.push({
          id: `${edgeId}:${packetSequenceRef.current++}`,
          edgeId,
          delayMs: (index / packetCount) * PACKET_STAGGER_MS,
          durationMs: PACKET_MS,
        })
      }
    }
    if (nextPackets.length > 0) {
      // The depth chart already jumped to this publication's newest sample.
      // Replace any older visual replay so the synoptic depicts this same batch
      // instead of accumulating an animation backlog under sustained traffic.
      for (const timeout of packetTimeoutsRef.current) window.clearTimeout(timeout)
      packetTimeoutsRef.current = []
      setPackets(nextPackets.slice(-MAX_LIVE_PACKETS))
      const timeout = window.setTimeout(() => {
        setPackets([])
        packetTimeoutsRef.current = []
      }, PACKET_CLEANUP_MS)
      packetTimeoutsRef.current.push(timeout)
    }
    setClock(now)
  }, [eventCount, live.flow])

  useEffect(() => {
    const now = performance.now()
    let nextBoundary = Number.POSITIVE_INFINITY
    for (const [edgeId, activity] of activityRef.current) {
      if (activity.untilWarm <= now) {
        activityRef.current.delete(edgeId)
        continue
      }
      nextBoundary = Math.min(
        nextBoundary,
        activity.untilHot > now ? activity.untilHot : activity.untilWarm,
      )
    }
    if (!Number.isFinite(nextBoundary)) return
    // Repaint only when an edge changes hot/warm state. The old 180 ms polling
    // loop needlessly rerendered the entire SVG between those two boundaries.
    const timeout = window.setTimeout(
      () => setClock(performance.now()),
      Math.max(16, Math.ceil(nextBoundary - now) + 1),
    )
    return () => window.clearTimeout(timeout)
  }, [clock])

  useEffect(
    () => () => {
      for (const timeout of packetTimeoutsRef.current) window.clearTimeout(timeout)
      if (occupancyTimeoutRef.current !== undefined) {
        window.clearTimeout(occupancyTimeoutRef.current)
      }
    },
    [],
  )

  const edgeActivity = useMemo(() => {
    const activity = new Map<string, QueueGraphEdgeActivity>()
    for (const [edgeId, state] of activityRef.current) {
      if (clock >= state.untilWarm) continue
      activity.set(edgeId, {
        hot: clock < state.untilHot,
        warm: clock < state.untilWarm,
        count: state.count,
      })
    }
    return activity
  }, [clock])

  const objectCount = live.nodes.filter((node) => !isActorNode(node)).length
  const shownObjectCount = live.graph.nodes.filter((node) => !isActorNode(node)).length
  const empty = live.graph.nodes.length === 0

  return (
    <section
      data-testid="live-queue-graph"
      className="overflow-hidden rounded-lg border border-border/60 bg-slate-950/55"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-slate-900/50 px-3 py-2 text-[10px] text-slate-400">
        <span className="font-medium uppercase tracking-[0.12em] text-slate-300">
          Live IPC topology · {countLabel(shownObjectCount, objectCount, 'object')} ·{' '}
          {countLabel(live.graph.edges.length, live.flows.length, 'route')}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          {legendItems(live.graph).map((item) => (
            <LegendItem key={item.label} {...item} />
          ))}
        </span>
      </div>
      <IpcFilterBar
        nodes={live.nodes}
        filter={filter}
        focused={live.focused}
        privateCount={live.privateCount}
      />
      {/* The canvas's own height, measured even before there is a layout to
          draw, so the first one can already pick the direction that fits. */}
      <div ref={frameRef} className="h-[clamp(16rem,42vh,28rem)] min-h-64">
        {empty ? (
          <div className="grid h-full place-items-center gap-2 px-6 text-center text-sm text-slate-500">
            <span>
              Nothing in the graph matches this filter.{' '}
              <button
                type="button"
                className="text-slate-300 underline underline-offset-2 hover:text-slate-100"
                onClick={ipcUi.clearIpcFilter}
              >
                Clear it
              </button>
            </span>
          </div>
        ) : layoutError ? (
          <div className="grid h-full place-items-center px-6 text-sm text-rose-300">
            Could not lay out IPC topology: {layoutError}
          </div>
        ) : layout ? (
          <QueueGraphCanvas
            layout={layout}
            nodeState={nodeState}
            edgeActivity={edgeActivity}
            edgeState={syncView?.edgeState}
            packets={packets}
            focusedNodeId={live.focused ? filter.focus : null}
            onNodeClick={(nodeId) => ipcUi.setIpcFocus(filter.focus === nodeId ? null : nodeId)}
            onClearFocus={() => ipcUi.setIpcFocus(null)}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-slate-500">
            Computing IPC layout…
          </div>
        )}
      </div>
    </section>
  )
}
