/**
 * CPU idle / active residency from schedule CTF — Power tab Phase 1.
 * Real pm_* CTF (system state, device runtime) is Phase 2; see docs/trace-power-plan.md.
 */

import type { Trace } from './reader'

export type CpuMode = 'active' | 'idle'

export interface CpuResidencySeg {
  start: number
  end: number
  mode: CpuMode
}

export interface WakeMark {
  ts: number
  reason: 'isr' | 'thread'
}

export interface CpuResidency {
  segments: CpuResidencySeg[]
  wakes: WakeMark[]
  hasIdleThread: boolean
}

export interface ResidencyWindowStats {
  busyPct: number
  idlePct: number
  knownPct: number
  wakeCount: number
  idleBouts: number
  meanIdleNs: number
  spanNs: number
  activeNs: number
  idleNs: number
}

/** Thread ids whose Zephyr name is the idle thread. */
export function idleThreadIds(tr: Trace): Set<number> {
  const ids = new Set<number>()
  for (const [id, info] of tr.threads) {
    if (info.name === 'idle') ids.add(id)
  }
  return ids
}

/**
 * Map running-thread spans onto active/idle residency and mark wakes.
 * ISR starts that interrupt an idle bout count as ISR wakes; idle→active
 * segment edges count as thread wakes.
 */
export function reconstructCpuResidency(tr: Trace): CpuResidency {
  const idleIds = idleThreadIds(tr)
  const segments: CpuResidencySeg[] = []

  for (const [start, end, tid] of tr.segments) {
    if (!(end > start)) continue
    const mode: CpuMode = idleIds.has(tid) ? 'idle' : 'active'
    const last = segments[segments.length - 1]
    if (last && last.mode === mode && last.end === start) {
      last.end = end
    } else {
      segments.push({ start, end, mode })
    }
  }

  const wakes: WakeMark[] = []
  const wakeTs = new Set<number>()

  const pushWake = (ts: number, reason: WakeMark['reason']) => {
    if (wakeTs.has(ts)) return
    wakeTs.add(ts)
    wakes.push({ ts, reason })
  }

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!
    const cur = segments[i]!
    if (prev.mode === 'idle' && cur.mode === 'active') {
      pushWake(cur.start, 'thread')
    }
  }

  for (const [isrStart] of tr.isrSpans) {
    for (const seg of segments) {
      if (seg.mode === 'idle' && seg.start <= isrStart && isrStart < seg.end) {
        pushWake(isrStart, 'isr')
        break
      }
    }
  }

  wakes.sort((a, b) => a.ts - b.ts || (a.reason < b.reason ? -1 : 1))

  return {
    segments,
    wakes,
    hasIdleThread: idleIds.size > 0,
  }
}

function clipDuration(start: number, end: number, t0: number, t1: number): number {
  const s = Math.max(start, t0)
  const e = Math.min(end, t1)
  return e > s ? e - s : 0
}

/** Busy / idle percentages and idle-bout stats over [t0, t1]. */
export function residencyWindowStats(
  res: CpuResidency,
  t0: number,
  t1: number,
): ResidencyWindowStats {
  const spanNs = Math.max(1, t1 - t0)
  let activeNs = 0
  let idleNs = 0
  let idleBouts = 0
  let idleBoutSum = 0

  for (const seg of res.segments) {
    const d = clipDuration(seg.start, seg.end, t0, t1)
    if (d <= 0) continue
    if (seg.mode === 'idle') {
      idleNs += d
      idleBouts += 1
      idleBoutSum += d
    } else {
      activeNs += d
    }
  }

  const known = activeNs + idleNs
  const wakeCount = res.wakes.filter((w) => w.ts >= t0 && w.ts <= t1).length

  return {
    busyPct: Math.max(0, Math.min(1, activeNs / spanNs)),
    idlePct: Math.max(0, Math.min(1, idleNs / spanNs)),
    knownPct: Math.max(0, Math.min(1, known / spanNs)),
    wakeCount,
    idleBouts,
    meanIdleNs: idleBouts > 0 ? idleBoutSum / idleBouts : 0,
    spanNs,
    activeNs,
    idleNs,
  }
}

/**
 * Bucketed busy fraction across [t0, t1] for the duty sparkline.
 * Each bucket is activeNs / bucketWidth (missing schedule → 0).
 */
export function dutyBuckets(
  res: CpuResidency,
  t0: number,
  t1: number,
  n: number,
): number[] {
  const buckets = Math.max(1, Math.floor(n))
  const span = Math.max(1, t1 - t0)
  const width = span / buckets
  const out = Array.from({ length: buckets }, () => 0)

  for (const seg of res.segments) {
    if (seg.mode !== 'active') continue
    if (seg.end <= t0 || seg.start >= t1) continue
    let s = Math.max(seg.start, t0)
    const e = Math.min(seg.end, t1)
    while (s < e) {
      const idx = Math.min(buckets - 1, Math.floor((s - t0) / width))
      const bucketEnd = t0 + (idx + 1) * width
      const sliceEnd = Math.min(e, bucketEnd)
      out[idx]! += sliceEnd - s
      s = sliceEnd
    }
  }

  return out.map((active) => Math.max(0, Math.min(1, active / width)))
}

/** Compact duration for metrics (guest CTF ns). */
export function formatResidencyDuration(ns: number): string {
  if (!(ns > 0) || !Number.isFinite(ns)) return '—'
  if (ns < 1_000) return `${Math.round(ns)} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(ns < 10_000 ? 1 : 0)} µs`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(ns < 10_000_000 ? 1 : 0)} ms`
  return `${(ns / 1_000_000_000).toFixed(2)} s`
}

export function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  const pct = Math.max(0, Math.min(100, fraction * 100))
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`
}
