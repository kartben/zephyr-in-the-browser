import { isWriteAction, type FlowNodeSpec, type FlowSpec } from './model'

/**
 * Pick the side of its mutex each lock route sits on, so the layout puts a
 * mutex between the threads that share it rather than past all of them.
 *
 * A lock has no direction, but ELK lays the graph out left to right along its
 * edges. Every other route has one: data and signals run from the actor that
 * puts or gives, through the object, to the actor that gets or waits. Those
 * routes rank the nodes, a cycle counting as one rank. A semaphore that one
 * thread both gives and takes is a lock and has no direction either, so it is
 * left out. The users of a mutex that rank lowest come in on its left and the
 * others leave on its right: in the sensor pipeline the aggregator sits before
 * `bus_mutex`, and `storage`, which no other route ranks, after it. A mutex
 * none of whose users rank has them all on its left.
 */
export function orientLocks(nodes: FlowNodeSpec[], flows: FlowSpec[]): FlowSpec[] {
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]))
  const lockLike = lockLikeSems(flows, kindById)
  const next = new Map<string, string[]>()
  const link = (from: string, to: string) => {
    let out = next.get(from)
    if (!out) next.set(from, (out = []))
    out.push(to)
    if (!next.has(to)) next.set(to, [])
  }
  for (const flow of flows) {
    if (flow.action === 'lock' || lockLike.has(flow.objectId)) continue
    if (isWriteAction(flow.action)) link(flow.actorId, flow.objectId)
    else link(flow.objectId, flow.actorId)
  }
  const rank = componentRanks(next)

  const users = new Map<string, FlowSpec[]>()
  for (const flow of flows) {
    if (flow.action !== 'lock') continue
    const list = users.get(flow.objectId) ?? []
    list.push(flow)
    users.set(flow.objectId, list)
  }
  const side = new Map<string, 'in' | 'out'>()
  for (const locks of users.values()) {
    const ranks = locks.flatMap((flow) => {
      const r = rank.get(flow.actorId)
      return r === undefined ? [] : [r]
    })
    const lowest = ranks.length > 0 ? Math.min(...ranks) : null
    for (const flow of locks) {
      side.set(flow.id, lowest === null || rank.get(flow.actorId) === lowest ? 'in' : 'out')
    }
  }
  return flows.map((flow) => {
    const s = side.get(flow.id)
    return s ? { ...flow, side: s } : flow
  })
}

function lockLikeSems(flows: FlowSpec[], kindById: Map<string, string>): Set<string> {
  const givers = new Map<string, Set<string>>()
  const takers = new Map<string, Set<string>>()
  for (const flow of flows) {
    if (kindById.get(flow.objectId) !== 'sem') continue
    const by = flow.action === 'give' ? givers : flow.action === 'take' ? takers : null
    if (!by) continue
    let set = by.get(flow.objectId)
    if (!set) by.set(flow.objectId, (set = new Set()))
    set.add(flow.actorId)
  }
  const out = new Set<string>()
  for (const [sem, given] of givers) {
    const taken = takers.get(sem)
    if (taken && [...given].some((actor) => taken.has(actor))) out.add(sem)
  }
  return out
}

/**
 * Longest-path rank of each node, with the nodes of each strongly connected
 * component (Tarjan) sharing one rank, so a cycle neither breaks the ranking
 * nor leaves everything after it at 0.
 */
function componentRanks(next: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const component = new Map<string, number>()
  let counter = 0
  let components = 0

  const visit = (v: string) => {
    index.set(v, counter)
    low.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.set(w, components)
      } while (w !== v)
      components++
    }
  }
  for (const v of next.keys()) if (!index.has(v)) visit(v)

  // Tarjan finishes a component only after every component it reaches, so
  // walking them from the last finished to the first is a topological order.
  const successors = Array.from({ length: components }, () => new Set<number>())
  for (const [v, out] of next) {
    for (const w of out) {
      const from = component.get(v)!
      const to = component.get(w)!
      if (from !== to) successors[from]!.add(to)
    }
  }
  const componentRank = Array.from({ length: components }, () => 0)
  for (let c = components - 1; c >= 0; c--) {
    for (const d of successors[c]!) componentRank[d] = Math.max(componentRank[d]!, componentRank[c]! + 1)
  }
  return new Map([...component].map(([v, c]) => [v, componentRank[c]!]))
}
