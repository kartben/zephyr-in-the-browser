import { useEffect, useMemo, useRef, useState } from 'react'
import {
  QueueGraphCanvas,
  type QueueGraphEdgeActivity,
  type QueueGraphPacket,
} from '@/components/queueGraph/QueueGraphCanvas'
import { layoutSemanticGraph, type QueueGraphLayout } from '@/components/queueGraph/layout'
import {
  buildLiveQueueGraph,
  liveEdgeId,
  liveQueueNodeState,
} from '@/components/queueGraph/live'
import { flowActionColor } from '@/components/queueGraph/model'
import { advanceFlowCursor, type QueueFlowEvent } from '@/ctf/queueGraph'
import type { QueueSeries, Trace } from '@/ctf'

const HOT_MS = 1200
const WARM_MS = 4200
const MAX_PACKETS_PER_BURST = 3
const MAX_LIVE_PACKETS = 48

type EdgeActivityState = {
  count: number
  untilHot: number
  untilWarm: number
}

function groupNewEvents(events: QueueFlowEvent[]): Map<string, QueueFlowEvent[]> {
  const grouped = new Map<string, QueueFlowEvent[]>()
  for (const event of events) {
    if (!event.ok || event.threadId == null) continue
    const id = liveEdgeId(event)
    const group = grouped.get(id) ?? []
    group.push(event)
    grouped.set(id, group)
  }
  return grouped
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-0.5 w-5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}

export function QueueGraph({
  tr,
  queues,
  eventCount,
}: {
  tr: Trace
  queues: QueueSeries[]
  eventCount: number
}) {
  const live = useMemo(() => buildLiveQueueGraph(tr, queues), [tr, queues, eventCount])
  const graphForLayout = useMemo(() => live.graph, [live.topologyKey])
  const nodeState = useMemo(() => liveQueueNodeState(tr, queues), [tr, queues, eventCount])
  const [layout, setLayout] = useState<QueueGraphLayout | null>(null)
  const [layoutError, setLayoutError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => performance.now())
  const [packets, setPackets] = useState<QueueGraphPacket[]>([])
  const lastIndexRef = useRef(-1)
  const activityRef = useRef(new Map<string, EdgeActivityState>())
  const packetSequenceRef = useRef(0)
  const packetTimeoutsRef = useRef<number[]>([])

  useEffect(() => {
    let current = true
    setLayoutError(null)
    layoutSemanticGraph(graphForLayout)
      .then((next) => {
        if (current) setLayout(next)
      })
      .catch((reason: unknown) => {
        if (!current) return
        setLayoutError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      current = false
    }
  }, [graphForLayout])

  useEffect(() => {
    const advanced = advanceFlowCursor(live.flow, lastIndexRef.current)
    lastIndexRef.current = advanced.nextIndex
    const now = performance.now()

    if (advanced.kind === 'first') {
      for (const event of live.flow.filter((candidate) => candidate.ok && candidate.threadId != null).slice(-10)) {
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
          delayMs: (index / packetCount) * 90,
        })
      }
    }
    if (nextPackets.length > 0) {
      const packetIds = new Set(nextPackets.map((packet) => packet.id))
      setPackets((current) => [...current, ...nextPackets].slice(-MAX_LIVE_PACKETS))
      const timeout = window.setTimeout(() => {
        setPackets((current) => current.filter((packet) => !packetIds.has(packet.id)))
        packetTimeoutsRef.current = packetTimeoutsRef.current.filter(
          (candidate) => candidate !== timeout,
        )
      }, 1100)
      packetTimeoutsRef.current.push(timeout)
    }
    setClock(now)
  }, [eventCount, live.flow])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = performance.now()
      let hasWarmEdge = false
      for (const [edgeId, activity] of activityRef.current) {
        if (activity.untilWarm <= now) activityRef.current.delete(edgeId)
        else hasWarmEdge = true
      }
      if (hasWarmEdge) setClock(now)
    }, 180)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(
    () => () => {
      for (const timeout of packetTimeoutsRef.current) window.clearTimeout(timeout)
    },
    [],
  )

  const edgeActivity = useMemo(() => {
    const activity = new Map<string, QueueGraphEdgeActivity>()
    for (const [edgeId, state] of activityRef.current) {
      activity.set(edgeId, {
        hot: clock < state.untilHot,
        warm: clock < state.untilWarm,
        count: state.count,
      })
    }
    return activity
  }, [clock])

  return (
    <section
      data-testid="live-queue-graph"
      className="overflow-hidden rounded-lg border border-border/60 bg-slate-950/55"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-slate-900/50 px-3 py-2 text-[10px] text-slate-400">
        <span className="font-medium uppercase tracking-[0.12em] text-slate-300">
          Live IPC topology · {queues.length} object{queues.length === 1 ? '' : 's'} ·{' '}
          {live.graph.edges.length} route{live.graph.edges.length === 1 ? '' : 's'}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          <LegendItem color={flowActionColor('put')} label="put / push" />
          <LegendItem color={flowActionColor('put-front')} label="put front" />
          <LegendItem color={flowActionColor('get')} label="get / pop" />
          <LegendItem color="#a78bfa" label="thread" />
        </span>
      </div>
      <div>
        {layoutError ? (
          <div className="grid h-32 place-items-center px-6 text-sm text-rose-300">
            Could not lay out IPC topology: {layoutError}
          </div>
        ) : layout ? (
          <QueueGraphCanvas
            layout={layout}
            nodeState={nodeState}
            edgeActivity={edgeActivity}
            packets={packets}
          />
        ) : (
          <div className="grid h-32 place-items-center text-sm text-slate-500">
            Computing IPC layout…
          </div>
        )}
      </div>
    </section>
  )
}
