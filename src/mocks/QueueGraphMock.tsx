import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { IpcFilterBar } from '@/components/queueGraph/IpcFilterBar'
import { QueueGraphCanvas } from '@/components/queueGraph/QueueGraphCanvas'
import { filterIpcGraph } from '@/components/queueGraph/filter'
import { validateQueueGraphLayout } from '@/components/queueGraph/geometry'
import {
  layoutSemanticGraph,
  type QueueGraphLayout,
} from '@/components/queueGraph/layout'
import { buildSemanticGraph, flowActionColor, type FlowAction } from '@/components/queueGraph/model'
import * as ipcUi from '@/lib/ipcUi'
import {
  queueGraphLargeCapacityMockSpecs,
  queueGraphMockSpecs,
  queueGraphRoutingStressMockSpecs,
} from './queueGraphMockData'

function LegendItem({ action, label }: { action: FlowAction; label: string }) {
  return (
    <span className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="h-0.5 w-7 rounded-full" style={{ backgroundColor: flowActionColor(action) }} />
      {label}
    </span>
  )
}

export function QueueGraphMock() {
  const [scenario, setScenario] = useState<'typical' | 'large' | 'routing'>('typical')
  const [layout, setLayout] = useState<QueueGraphLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const specs =
    scenario === 'routing'
      ? queueGraphRoutingStressMockSpecs
      : scenario === 'large'
        ? queueGraphLargeCapacityMockSpecs
        : queueGraphMockSpecs
  const filter = useSyncExternalStore(ipcUi.subscribe, ipcUi.getSnapshot, ipcUi.getSnapshot)
  const filtered = useMemo(() => filterIpcGraph(specs.nodes, specs.flows, filter), [specs, filter])
  const graph = useMemo(() => buildSemanticGraph(filtered.nodes, filtered.flows), [filtered])

  useEffect(() => {
    let current = true
    // Keep the last layout up while the next one runs, as the live graph does:
    // unmounting the canvas would drop the keyboard focus Escape needs.
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
            {scenario === 'routing'
              ? 'Routing stress: 19 nodes, 25 flows, mixed object semantics, long edges, and feedback cycles.'
              : 'Small capacities show exact slots; large capacities use a continuous proportional gauge. Exact values remain available in each object tooltip.'}
          </p>
          <div
            className="flex rounded-lg border border-slate-800 bg-slate-900/70 p-1 text-[11px]"
            aria-label="Mock scenario"
          >
            <button
              type="button"
              data-testid="capacity-typical"
              aria-pressed={scenario === 'typical'}
              className={
                scenario === 'typical'
                  ? 'rounded-md bg-slate-700 px-3 py-1.5 text-slate-100'
                  : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
              }
              onClick={() => setScenario('typical')}
            >
              Typical capacity
            </button>
            <button
              type="button"
              data-testid="capacity-large"
              aria-pressed={scenario === 'large'}
              className={
                scenario === 'large'
                  ? 'rounded-md bg-violet-500/25 px-3 py-1.5 text-violet-200'
                  : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
              }
              onClick={() => setScenario('large')}
            >
              Large-capacity stress
            </button>
            <button
              type="button"
              data-testid="routing-stress"
              aria-pressed={scenario === 'routing'}
              className={
                scenario === 'routing'
                  ? 'rounded-md bg-sky-500/25 px-3 py-1.5 text-sky-200'
                  : 'rounded-md px-3 py-1.5 text-slate-400 hover:text-slate-200'
              }
              onClick={() => setScenario('routing')}
            >
              Routing stress · 3×
            </button>
          </div>
        </div>

        <section className="overflow-auto rounded-2xl border border-slate-800 bg-[#080d18] shadow-2xl shadow-black/30">
          <IpcFilterBar nodes={specs.nodes} filter={filter} focused={filtered.focused} />
          {error ? (
            <div className="p-8 text-sm text-rose-300">{error}</div>
          ) : layout ? (
            <QueueGraphCanvas
              layout={layout}
              ariaLabel="Synthetic Zephyr data-flow topology"
              focusedNodeId={filtered.focused ? filter.focus : null}
              onNodeClick={(nodeId) => ipcUi.setIpcFocus(filter.focus === nodeId ? null : nodeId)}
              onClearFocus={() => ipcUi.setIpcFocus(null)}
            />
          ) : (
            <div className="grid h-96 place-items-center text-sm text-slate-500">Computing layout…</div>
          )}
        </section>

        <footer className="flex flex-wrap justify-between gap-3 text-[11px] text-slate-500">
          <span>Hover a route to isolate its endpoints; click a node to focus on it.</span>
          <span>Mock data only.</span>
        </footer>
      </div>
    </main>
  )
}
