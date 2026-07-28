/**
 * Reconstruct per-msgq depth timelines from CTF put/get exits alone.
 *
 * Zephyr's msgq CTF events carry object address + ret — not used_msgs or
 * max_msgs. Counting successful puts (+1) and gets (−1) recovers depth when
 * the stream starts empty (or after a purge). Failed puts count as drops;
 * when a put fails the queue is full, so depth at that moment is the capacity.
 */

import {
  MSGQ_GET_EXIT,
  MSGQ_PURGE,
  MSGQ_PUT_EXIT,
  MSGQ_PUT_FRONT_EXIT,
} from './types'
import type { Trace } from './reader'

/** Depth after an event at `ts`. */
export interface QueueSample {
  ts: number
  depth: number
}

export interface QueueSeries {
  /** CTF msgq id = object address. */
  id: number
  name: string | null
  samples: QueueSample[]
  drops: number
  /** Inferred from a failed put while full; null if never observed full. */
  cap: number | null
  peak: number
}

const PUT_EXITS = new Set([MSGQ_PUT_EXIT, MSGQ_PUT_FRONT_EXIT])

type Acc = {
  depth: number
  drops: number
  cap: number | null
  peak: number
  samples: QueueSample[]
}

function ensure(map: Map<number, Acc>, id: number): Acc {
  let q = map.get(id)
  if (!q) {
    q = { depth: 0, drops: 0, cap: null, peak: 0, samples: [] }
    map.set(id, q)
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
 * Build one series per msgq seen in put/get/purge events.
 * `nameById` is optional (ELF wait-object names keyed by address).
 */
export function reconstructQueues(
  tr: Trace,
  nameById?: Map<number, string> | null,
): QueueSeries[] {
  const map = new Map<number, Acc>()

  for (const ev of tr.events) {
    const eid = ev.eid
    if (
      eid !== MSGQ_PUT_EXIT &&
      eid !== MSGQ_GET_EXIT &&
      eid !== MSGQ_PURGE &&
      eid !== MSGQ_PUT_FRONT_EXIT
    ) {
      continue
    }
    const idRaw = ev.fields.id
    if (typeof idRaw !== 'number') continue
    const q = ensure(map, idRaw)

    if (PUT_EXITS.has(eid)) {
      const ret = typeof ev.fields.ret === 'number' ? ev.fields.ret : 0
      if (ret === 0) {
        q.depth += 1
        pushSample(q, ev.ts)
      } else {
        q.drops += 1
        // Failed put ⇒ queue was already full at current depth (when non-empty).
        if (q.depth > 0) {
          q.cap = q.cap == null ? q.depth : Math.max(q.cap, q.depth)
        }
      }
    } else if (eid === MSGQ_GET_EXIT) {
      const ret = typeof ev.fields.ret === 'number' ? ev.fields.ret : 0
      if (ret === 0) {
        q.depth = Math.max(0, q.depth - 1)
        pushSample(q, ev.ts)
      }
    } else if (eid === MSGQ_PURGE) {
      if (q.depth !== 0) {
        q.depth = 0
        pushSample(q, ev.ts)
      }
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
    out.push({
      id,
      name: nameById?.get(id) ?? null,
      samples: q.samples,
      drops: q.drops,
      cap: q.cap,
      peak: q.peak,
    })
  }

  out.sort((a, b) => {
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
