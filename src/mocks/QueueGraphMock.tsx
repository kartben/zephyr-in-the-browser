import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IpcFilterBar } from '@/components/queueGraph/IpcFilterBar'
import { QueueGraphCanvas } from '@/components/queueGraph/QueueGraphCanvas'
import { filterIpcGraph } from '@/components/queueGraph/filter'
import { validateQueueGraphLayout } from '@/components/queueGraph/geometry'
import type { GraphDirection } from '@/components/queueGraph/layout'
import { buildSemanticGraph, flowActionColor, type FlowAction } from '@/components/queueGraph/model'
import { useElementSize, useFittedLayout } from '@/components/queueGraph/useFittedLayout'
import * as ipcUi from '@/lib/ipcUi'
import {
  queueGraphLargeCapacityMockSpecs,
  queueGraphMockSpecs,
  queueGraphPhilosophersMockSpecs,
  queueGraphRoutingStressMockSpecs,
  queueGraphSensorPipelineMockSpecs,
  queueGraphSensorPipelineMockState,
} from './queueGraphMockData'

type Scenario = 'typical' | 'large' | 'routing' | 'pipeline' | 'philosophers'

const SCENARIOS: Array<{ id: Scenario; label: string; on: string; specs: typeof queueGraphMockSpecs }> = [
  { id: 'typical', label: 'Typical capacity', on: 'bg-slate-700 text-slate-100', specs: queueGraphMockSpecs },
  {
    id: 'large',
    label: 'Large-capacity stress',
    on: 'bg-violet-500/25 text-violet-200',
    specs: queueGraphLargeCapacityMockSpecs,
  },
  {
    id: 'routing',
    label: 'Routing stress · 3×',
    on: 'bg-sky-500/25 text-sky-200',
    specs: queueGraphRoutingStressMockSpecs,
  },
  {
    id: 'pipeline',
    label: 'Sensor pipeline',
    on: 'bg-emerald-500/20 text-emerald-200',
    specs: queueGraphSensorPipelineMockSpecs,
  },
  {
    id: 'philosophers',
    label: 'Philosophers',
    on: 'bg-amber-500/20 text-amber-200',
    specs: queueGraphPhilosophersMockSpecs,
  },
]

const SCENARIO_NOTES: Record<Scenario, string> = {
  typical:
    'Small capacities show exact slots; large capacities use a continuous proportional gauge. Exact values remain available in each object tooltip.',
  large:
    'Small capacities show exact slots; large capacities use a continuous proportional gauge. Exact values remain available in each object tooltip.',
  routing: 'Routing stress: 19 nodes, 25 flows, mixed object semantics, long edges, and feedback cycles.',
  pipeline:
    'The tracing_pipeline sample where part 3 of its tour stops: storage holds bus_mutex at the priority the waiting aggregator lent it.',
  philosophers: 'Five philosophers and their forks: a ring of mutexes, with no data flow to rank them.',
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
  const [scenario, setScenario] = useState<Scenario>('typical')
  const [direction, setDirection] = useState<'auto' | GraphDirection>('auto')
  const frameRef = useRef<HTMLDivElement>(null)
  const frameSize = useElementSize(frameRef)
  const specs = SCENARIOS.find((s) => s.id === scenario)!.specs
  const liveState = scenario === 'pipeline' ? queueGraphSensorPipelineMockState : null
  const filter = useSyncExternalStore(ipcUi.subscribe, ipcUi.getSnapshot, ipcUi.getSnapshot)
  const filtered = useMemo(() => filterIpcGraph(specs.nodes, specs.flows, filter), [specs, filter])
  const request = useMemo(() => {
    const graph = buildSemanticGraph(filtered.nodes, filtered.flows)
    const key = [
      ...graph.nodes.map((node) => node.id),
      ...graph.edges.map((edge) => `${edge.id}:${edge.sourceNodeId}:${edge.targetNodeId}`),
    ].join('|')
    return { key, graph }
  }, [filtered])
  const { layout, error } = useFittedLayout(
    request,
    frameSize,
    direction === 'auto' ? undefined : direction,
  )

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
                {layout
                  ? `${issues.length} geometry issues · ${layout.direction === 'DOWN' ? 'top to bottom' : 'left to right'}`
                  : 'layout running'}
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
          <p className="text-[11px] text-slate-500">{SCENARIO_NOTES[scenario]}</p>
          <div
            className="flex flex-wrap rounded-lg border border-slate-800 bg-slate-900/70 p-1 text-[11px]"
            aria-label="Mock scenario"
          >
            {SCENARIOS.map(({ id, label, on }) => (
              <button
                key={id}
                type="button"
                data-testid={`scenario-${id}`}
                aria-pressed={scenario === id}
                className={
                  scenario === id
                    ? `rounded-md px-3 py-1.5 ${on}`
                    : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
                }
                onClick={() => setScenario(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="flex rounded-lg border border-slate-800 bg-slate-900/70 p-1 text-[11px]"
            aria-label="Layout direction"
          >
            {(
              [
                ['auto', 'Fit'],
                ['RIGHT', 'Left to right'],
                ['DOWN', 'Top to bottom'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={direction === id}
                className={
                  direction === id
                    ? 'rounded-md bg-slate-700 px-3 py-1.5 text-slate-100'
                    : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
                }
                onClick={() => setDirection(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <section className="overflow-auto rounded-2xl border border-slate-800 bg-[#080d18] shadow-2xl shadow-black/30">
          <IpcFilterBar
            nodes={specs.nodes}
            filter={filter}
            focused={filtered.focused}
            privateCount={filtered.privateCount}
          />
          <div ref={frameRef} className="h-[clamp(16rem,42vh,28rem)] min-h-64">
            {error ? (
              <div className="p-8 text-sm text-rose-300">{error}</div>
            ) : layout ? (
              <QueueGraphCanvas
                layout={layout}
                nodeState={liveState?.nodeState}
                edgeState={liveState?.edgeState}
                ariaLabel="Synthetic Zephyr data-flow topology"
                focusedNodeId={filtered.focused ? filter.focus : null}
                onNodeClick={(nodeId) => ipcUi.setIpcFocus(filter.focus === nodeId ? null : nodeId)}
                onClearFocus={() => ipcUi.setIpcFocus(null)}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-slate-500">Computing layout…</div>
            )}
          </div>
        </section>

        <footer className="flex flex-wrap justify-between gap-3 text-[11px] text-slate-500">
          <span>Hover a route to isolate its endpoints; click a node to focus on it.</span>
          <span>Mock data only.</span>
        </footer>
      </div>
    </main>
  )
}
