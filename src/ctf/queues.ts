/**
 * Reconstruct per-object depth timelines from CTF put/get exits.
 *
 * Covers msgq, fifo, lifo, bare k_queue, and k_stack. Zephyr events carry object
 * address + ret — not used count. Counting successful puts (+1) and gets (−1)
 * recovers depth when the stream starts empty (or after a msgq purge).
 *
 * A put that finds a receiver already waiting does not go through the queue:
 * the kernel gives the item straight to that receiver, and the depth never
 * changes. Both exits are still in the trace, so counting them would draw a
 * one-message spike, or a step up that never comes down when the receiver's
 * exit comes first (k_queue and k_stack trace their put exit after the
 * reschedule). A receiver says it is about to wait (`*_get_blocking`), so the
 * replay counts the receivers waiting on each object, and a put that reaches
 * one is a hand-off: the depth stays where it is, and the series lists the put
 * in `handoffs`.
 *
 * FIFO/LIFO nest k_queue with the same `id`; nested queue_* events are ignored
 * when an outer fifo/lifo kind is known for that address.
 */

import {
  classifyQueueEvent,
  classifyQueueKinds,
  classifyReceiverBlocking,
  isNestedQueueEvent,
  type QueueKind,
} from './queueKinds'
import type { Trace } from './reader'

/** Depth after an event at `ts`. */
export interface QueueSample {
  ts: number
  depth: number
}

/** A put that went straight to a receiver already waiting on the object. */
export interface QueueHandoff {
  /** The put's exit. */
  ts: number
  /** The put's exit, as an index into `tr.events`. */
  putIndex: number
  /** The receiver's get exit, as an index into `tr.events`; null until it is seen. */
  getIndex: number | null
}

export interface QueueSeries {
  /** CTF object id = object address. */
  id: number
  kind: QueueKind
  name: string | null
  samples: QueueSample[]
  drops: number
  /** Fixed object-core bound, inferred full depth, or null when still unknown. */
  cap: number | null
  /** Whether the bound came from the kernel object or trace-event inference. */
  capSource: 'object-core' | 'inferred' | null
  peak: number
  /** Puts the queue never held, because a receiver was already waiting. */
  handoffs: QueueHandoff[]
}

type Acc = {
  kind: QueueKind
  depth: number
  drops: number
  cap: number | null
  peak: number
  samples: QueueSample[]
  handoffs: QueueHandoff[]
}

/** Receivers waiting on one object, and hand-offs with one exit still to come. */
type Waiting = {
  /** Receivers that said they would wait and have not returned yet. */
  receivers: number
  /** Hand-offs whose put exit came first, oldest first. */
  sent: QueueHandoff[]
  /**
   * Waiting receivers that returned with an item before the put that sent it
   * exited, oldest first. `refill` marks the msgq case below, which is not a
   * hand-off at all.
   */
  received: { getIndex: number; refill: boolean }[]
}

function ensure(map: Map<number, Acc>, id: number, kind: QueueKind): Acc {
  let q = map.get(id)
  if (!q) {
    q = { kind, depth: 0, drops: 0, cap: null, peak: 0, samples: [], handoffs: [] }
    map.set(id, q)
  } else if ((kind === 'fifo' || kind === 'lifo') && q.kind === 'queue') {
    q.kind = kind
  }
  return q
}

function pushSample(q: Acc, ts: number) {
  q.peak = Math.max(q.peak, q.depth)
  const last = q.samples[q.samples.length - 1]
  if (last && last.ts === ts) {
    last.depth = q.depth
    return
  }
  if (last && last.depth === q.depth) return
  q.samples.push({ ts, depth: q.depth })
}

/**
 * Build one series per data-passing object seen in put/get/purge exits.
 * `nameById` is optional (ELF wait-object names keyed by address).
 */
export function reconstructQueues(
  tr: Trace,
  nameById?: Map<number, string> | null,
  capacityById?: Map<number, number> | null,
): QueueSeries[] {
  const kinds = classifyQueueKinds(tr.events)
  const map = new Map<number, Acc>()
  const waiting = new Map<number, Waiting>()

  for (let i = 0; i < tr.events.length; i++) {
    const ev = tr.events[i]!
    const waitedOn = classifyReceiverBlocking(ev.name, ev.fields)
    if (waitedOn != null) {
      let w = waiting.get(waitedOn)
      if (!w) {
        w = { receivers: 0, sent: [], received: [] }
        waiting.set(waitedOn, w)
      }
      w.receivers += 1
      continue
    }

    const classified = classifyQueueEvent(ev.name, ev.fields)
    if (!classified) continue
    if (isNestedQueueEvent(classified, kinds)) continue

    const kind = kinds.get(classified.id) ?? classified.kind
    const q = ensure(map, classified.id, kind)
    const w = waiting.get(classified.id)

    if (classified.depthAction === 'purge') {
      if (q.depth !== 0) {
        q.depth = 0
        pushSample(q, ev.ts)
      }
      continue
    }

    if (classified.depthAction === 'put') {
      if (classified.ok) {
        const early = w?.received.shift()
        if (early) {
          // Its receiver already returned with it: k_queue and k_stack trace a
          // hand-off's put exit after the receiver has run. A msgq traces it
          // before, so on a msgq this is a get that made room on a full queue
          // and moved this blocked sender's message in. Either way the depth
          // stays where it is.
          if (!early.refill) q.handoffs.push({ ts: ev.ts, putIndex: i, getIndex: early.getIndex })
          continue
        }
        if (w && w.receivers > w.sent.length) {
          const handoff: QueueHandoff = { ts: ev.ts, putIndex: i, getIndex: null }
          w.sent.push(handoff)
          q.handoffs.push(handoff)
          continue
        }
        q.depth += 1
        pushSample(q, ev.ts)
      } else if (classified.kind === 'msgq') {
        // Failed msgq put ⇒ drops + capacity inference when depth known.
        q.drops += 1
        if (q.depth > 0) {
          q.cap = q.cap == null ? q.depth : Math.max(q.cap, q.depth)
        }
      }
      continue
    }

    if (classified.depthAction !== 'get') continue
    if (w && w.receivers > 0) {
      // A receiver that waited is back. What it got never sat in the queue.
      w.receivers -= 1
      if (classified.ok) {
        const handoff = w.sent.shift()
        if (handoff) handoff.getIndex = i
        else w.received.push({ getIndex: i, refill: kind === 'msgq' })
      } else if (w.sent.length > w.receivers) {
        w.sent.length = w.receivers
      }
      continue
    }
    if (classified.ok) {
      q.depth = Math.max(0, q.depth - 1)
      pushSample(q, ev.ts)
    }
  }

  const out: QueueSeries[] = []
  for (const [id, q] of map) {
    if (q.samples.length === 0) {
      q.samples.push({ ts: tr.t0, depth: 0 })
    }
    // Hold the last depth through the live edge.
    const last = q.samples[q.samples.length - 1]!
    if (tr.t1 > last.ts) q.samples.push({ ts: tr.t1, depth: q.depth })
    const objectCapacity = capacityById?.get(id)
    const hasObjectCapacity =
      objectCapacity != null && Number.isFinite(objectCapacity) && objectCapacity > 0
    out.push({
      id,
      kind: q.kind,
      name: nameById?.get(id) ?? null,
      samples: q.samples,
      drops: q.drops,
      cap: hasObjectCapacity ? objectCapacity : q.cap,
      capSource: hasObjectCapacity ? 'object-core' : q.cap != null ? 'inferred' : null,
      peak: q.peak,
      handoffs: q.handoffs,
    })
  }

  out.sort((a, b) => {
    // Alphabetical fallback — QueuesView re-sorts with longest-path pipeline
    // order (sortQueuesByPipelineOrder) so the chart matches the topology graph.
    if (a.name && b.name && a.name !== b.name) return a.name.localeCompare(b.name)
    if (a.name && !b.name) return -1
    if (!a.name && b.name) return 1
    return a.id - b.id
  })
  return out
}

/**
 * Depth at `ts` from a step series (last sample with sample.ts <= ts).
 * Before the first sample the queue is treated as empty.
 */
export function depthAt(samples: QueueSample[], ts: number): number {
  if (!samples.length || ts < samples[0]!.ts) return 0
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid]!.ts <= ts) lo = mid + 1
    else hi = mid
  }
  return samples[lo - 1]!.depth
}

/** Y-axis max for a chart: prefer known cap, else peak (at least 1). */
export function queueAxisMax(q: QueueSeries): number {
  if (q.cap != null && q.cap > 0) return q.cap
  return Math.max(1, q.peak)
}

/** Display label: ELF name when known, else hex id. */
export function queueLabel(q: QueueSeries): string {
  return q.name || `0x${q.id.toString(16)}`
}
