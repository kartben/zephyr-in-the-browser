/**
 * The "Try it" strip at the top of the dock: what to do with this sample, in
 * plain words, and a chip for each row the sample is about. A chip reveals its
 * row the way everything else does (revealDockRow: unhide, unfold its group,
 * expand, scroll to it, blink), so it finds the row however the dock happens
 * to be arranged. The words and the rules live in lib/tryIt.ts.
 */

import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import type { PanelKind } from '@/boards'
import { deviceIcon } from '@/components/dock/deviceBodies'
import { INSTRUMENTS } from '@/components/dock/Instruments'
import type { DeviceNode } from '@/deviceTopology'
import * as guestStats from '@/guestStats'
import * as hostTrace from '@/hostTrace'
import { revealDockRow } from '@/lib/dockReveal'
import { getState as getDockState, subscribe as subscribeDock } from '@/lib/dockStore'
import {
  getDismissed,
  setTryItDismissed,
  splitCode,
  subscribe as subscribeTryIt,
  tryItFor,
  tryItTargets,
  type TryItTarget,
} from '@/lib/tryIt'
import * as tours from '@/tours/store'

// Narrow snapshots, so the strip re-renders when its answer changes rather
// than on every tick of these stores (Trace and guest stats tick at 2-5 Hz).
const selection = () => getDockState().seededFor
const touring = () => tours.tourInProgress(tours.getSnapshot())
const traceAvailable = () => hostTrace.getSnapshot().available
const statsAvailable = () => guestStats.getSnapshot().available

export function TryIt({ nodes }: { nodes: readonly DeviceNode[] }) {
  const seededFor = useSyncExternalStore(subscribeDock, selection, selection)
  const dismissed = useSyncExternalStore(subscribeTryIt, getDismissed, getDismissed)
  const inTour = useSyncExternalStore(tours.subscribe, touring, touring)
  const trace = useSyncExternalStore(hostTrace.subscribe, traceAvailable, traceAvailable)
  const stats = useSyncExternalStore(guestStats.subscribe, statsAvailable, statsAvailable)

  const hint = tryItFor(seededFor, dismissed, inTour)
  if (!hint) return null
  const { sample, line } = hint

  // An instrument chip only where its row has something to show: Trace on a
  // build that writes a trace (a traced twin from the first paint, any other
  // once events arrive), Simulation once the guest reports its speed. Debug
  // attaches on every sample that names it.
  const offered = (kind: PanelKind) =>
    kind === 'trace'
      ? trace || sample.tracedFrom !== undefined
      : kind === 'perf'
        ? stats
        : true
  const targets = tryItTargets(sample.primaryPanels ?? [], nodes, offered)

  return (
    <section
      aria-label="Try it"
      className="mx-0.5 mb-1.5 mt-0.5 rounded-md border border-primary/25 bg-primary/[0.05] px-2.5 py-2"
    >
      {/* The label on a line of its own, so the sentence gets the whole width. */}
      <div className="flex items-center gap-1.5">
        <p className="text-[11px] font-semibold text-primary-text">Try it</p>
        <button
          type="button"
          aria-label="Hide the Try it hint for this sample"
          title="Hide this hint. The Panels menu brings it back."
          onClick={() => setTryItDismissed(seededFor, true)}
          className="-mr-1 ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-foreground">
        {splitCode(line).map((part, i) =>
          i % 2 === 1 ? (
            <code
              key={i}
              className="rounded bg-secondary px-1 py-px font-mono text-[11px] text-foreground"
            >
              {part}
            </code>
          ) : (
            part
          ),
        )}
      </p>
      {targets.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {targets.map((target) => (
            <TryItChip key={target.key} target={target} />
          ))}
        </div>
      )}
    </section>
  )
}

/** A row's own name and icon, so the chip and the row it opens look alike. */
function chipFace(target: TryItTarget) {
  if (target.node) return { label: target.node.label, Icon: deviceIcon(target.node) }
  const instrument = INSTRUMENTS.find((i) => i.key === target.key)
  return { label: instrument?.label ?? target.kind, Icon: instrument?.icon }
}

function TryItChip({ target }: { target: TryItTarget }) {
  const { label, Icon } = chipFace(target)
  return (
    <button
      type="button"
      title={`Show ${label} in the dock`}
      onClick={() => revealDockRow(target.key, target.deviceClass)}
      className="flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-primary-text transition-colors hover:border-primary/50 hover:bg-primary/10"
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </button>
  )
}
