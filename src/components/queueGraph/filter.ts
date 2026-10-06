import type { IpcFilter } from '@/lib/ipcUi'
import {
  isActorNode,
  isSyncNode,
  type DataObjectKind,
  type FlowNodeSpec,
  type FlowSpec,
} from './model'

/**
 * Narrow the IPC graph to what the reader asked for, before it is laid out.
 *
 * Nodes and routes that do not match are dropped rather than dimmed: ELK then
 * lays out only what is left, and the camera fits it, so a focused corner of a
 * busy graph comes up large enough to read in the dock instead of staying a
 * speck of a picture that is still mostly everything else.
 */

export interface FilteredIpcGraph {
  nodes: FlowNodeSpec[]
  flows: FlowSpec[]
  /** The focus names a node still in the graph (a hidden or stale one does nothing). */
  focused: boolean
  /** Semaphores, mutexes and condvars only one actor uses, shown or not. */
  privateCount: number
}

/**
 * A semaphore, mutex or condvar that only one thread or ISR uses says nothing
 * about how threads get along: a lock nobody else takes is uncontended by
 * construction. Those wait behind a chip, unless asked for by name or focus.
 *
 * Kinds switched off go next, with their routes. A focus on an object keeps it
 * and every actor with a route to it; on a thread, the thread, the objects it
 * uses, and the other actors on those objects, which is who that thread talks
 * to. A name then keeps its matches and their direct neighbours, so no route is
 * left hanging off one end. Actors only exist through their routes, so one left
 * with none goes too, unless it is the focus itself.
 */
export function filterIpcGraph(
  nodes: FlowNodeSpec[],
  flows: FlowSpec[],
  filter: IpcFilter,
): FilteredIpcGraph {
  const query = filter.query.trim().toLowerCase()
  const actorsOf = new Map<string, Set<string>>()
  for (const flow of flows) {
    let actors = actorsOf.get(flow.objectId)
    if (!actors) actorsOf.set(flow.objectId, (actors = new Set()))
    actors.add(flow.actorId)
  }
  const privateIds = new Set(
    nodes
      .filter((node) => isSyncNode(node) && (actorsOf.get(node.id)?.size ?? 0) < 2)
      .map((node) => node.id),
  )
  const asked = (node: FlowNodeSpec) =>
    node.id === filter.focus || (query !== '' && node.label.toLowerCase().includes(query))
  let keptNodes = nodes.filter(
    (node) =>
      (isActorNode(node) || !filter.hiddenKinds.has(node.kind)) &&
      (filter.showPrivate || !privateIds.has(node.id) || asked(node)),
  )
  const visible = new Set(keptNodes.map((node) => node.id))
  let keptFlows = flows.filter((flow) => visible.has(flow.actorId) && visible.has(flow.objectId))

  const focus = filter.focus == null ? undefined : keptNodes.find((node) => node.id === filter.focus)
  if (focus) {
    const objects = new Set<string>()
    if (isActorNode(focus)) {
      for (const flow of keptFlows) if (flow.actorId === focus.id) objects.add(flow.objectId)
    } else {
      objects.add(focus.id)
    }
    keptFlows = keptFlows.filter((flow) => objects.has(flow.objectId))
    const keep = new Set([focus.id, ...objects, ...keptFlows.map((flow) => flow.actorId)])
    keptNodes = keptNodes.filter((node) => keep.has(node.id))
  }

  if (query) {
    const matched = new Set(
      keptNodes.filter((node) => node.label.toLowerCase().includes(query)).map((node) => node.id),
    )
    keptFlows = keptFlows.filter((flow) => matched.has(flow.actorId) || matched.has(flow.objectId))
    const keep = new Set(matched)
    for (const flow of keptFlows) {
      keep.add(flow.actorId)
      keep.add(flow.objectId)
    }
    keptNodes = keptNodes.filter((node) => keep.has(node.id))
  }

  const routed = new Set(keptFlows.map((flow) => flow.actorId))
  keptNodes = keptNodes.filter(
    (node) => !isActorNode(node) || routed.has(node.id) || node.id === focus?.id,
  )
  return {
    nodes: keptNodes,
    flows: keptFlows,
    focused: focus !== undefined,
    privateCount: privateIds.size,
  }
}

/** Object count per kind, for the kind chips; kinds with none are left out. */
export function ipcKindCounts(nodes: FlowNodeSpec[]): Map<DataObjectKind, number> {
  const counts = new Map<DataObjectKind, number>()
  for (const node of nodes) {
    if (isActorNode(node)) continue
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)
  }
  return counts
}
