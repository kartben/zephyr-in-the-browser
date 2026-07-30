/**
 * The devicetree of the running guest, when one is known.
 *
 * Two ways a tree arrives:
 *
 * - **Bundled sample** — the build ships `<app>.dts` next to `<app>.elf` and
 *   the backend fires `loadSampleDts` after picking the kernel. Absence is a
 *   supported state (older image tarballs have no .dts), so that path never
 *   throws and never delays a boot.
 * - **User ELF** — the drop/pick flow offers an optional zephyr.dts; it comes
 *   in through `setUserDts`, and survives Reload / refresh for the rest of the
 *   session via the same IndexedDB store the guest image uses (its own key).
 *   An explicit clear (or picking a bundled sample) drops it.
 *
 * Parse or insight failures degrade by stages: `doc: null` still shows raw
 * text in the viewer, `insights: null` sends every consumer to its hardcoded
 * fallback. Nothing here is allowed to make a boot worse than the pre-DTS
 * behavior.
 *
 * **Phase** tracks whether a tree is still expected, so the device dock does
 * not briefly paint the full static fallback while a sample `.dts` is in
 * flight (or before the first load has been asked for).
 */

import { computeInsights, parseDts } from '@/dts'
import type { DtsDocument, DtsInsights } from '@/dts'
import { handoffTx } from '@/guestImage'

const DTS_KEY = 'pending-guest-dts'

export interface DeviceTreeState {
  /** Fetched next to a bundled sample, or supplied by the user for their ELF. */
  source: 'sample' | 'user'
  /** File name, for display — `shell.dts`, or whatever the user dropped. */
  name: string
  text: string
  /** null: text did not parse (viewer falls back to raw text). */
  doc: DtsDocument | null
  /** null: no usable insights (every consumer falls back to its static table). */
  insights: DtsInsights | null
}

/**
 * Whether a usable tree is known, still expected, or confirmed missing.
 *
 * - `pending` — initial state, cleared between samples, or a fetch in flight.
 *   The dock stays empty; managed chips stay off the bus.
 * - `ready` — a sample or user tree is installed.
 * - `absent` — a fetch missed, or the user skipped the DTS prompt. Consumers
 *   may use their static fallback tables.
 */
export type DeviceTreePhase = 'pending' | 'ready' | 'absent'

let current: DeviceTreeState | null = null
let phase: DeviceTreePhase = 'pending'
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The devicetree in effect, or null when none is known. */
export function get(): DeviceTreeState | null {
  return current
}

/** Whether a tree is ready, still expected, or confirmed missing. */
export function getPhase(): DeviceTreePhase {
  return phase
}

function build(source: 'sample' | 'user', name: string, text: string): DeviceTreeState {
  let doc: DtsDocument | null = null
  let insights: DtsInsights | null = null
  try {
    doc = parseDts(text)
    insights = computeInsights(doc)
  } catch {
    // Keep whatever stage succeeded; the nulls select the fallbacks.
  }
  return { source, name, text, doc, insights }
}

/** Install a user-supplied devicetree for the current custom ELF. */
export function setUserDts(name: string, text: string) {
  fetchEpoch++ // a stale sample fetch must not clobber this
  current = build('user', name, text)
  phase = 'ready'
  notify()
  // Persist so Reload keeps the tree with the custom ELF (same contract as
  // guestImage.set). Sample trees are never written here.
  void stashUserDts(name, text).catch(() => {
    /* private mode, blocked storage — memory still holds this document's tree */
  })
}

/**
 * Forget the devicetree — e.g. when the guest changes under it. Leaves the
 * store in `pending` so the dock does not flash the full fallback while the
 * next sample's `.dts` is fetched. Call {@link markAbsent} when nothing more
 * is expected (user skipped the DTS prompt).
 */
export async function clear(): Promise<void> {
  fetchEpoch++ // ...nor resurrect what was just cleared
  const had = current !== null || phase !== 'pending'
  current = null
  phase = 'pending'
  if (had) notify()
  await clearStashedDts()
}

/**
 * Confirm that no devicetree is coming — panels and managed chips may use
 * their static fallback tables. Used when the user boots an ELF without a
 * `.dts`. Sample fetch misses set `absent` inside {@link loadSampleDts}.
 */
export async function markAbsent(): Promise<void> {
  fetchEpoch++
  const had = current !== null || phase !== 'absent'
  current = null
  phase = 'absent'
  if (had) notify()
  await clearStashedDts()
}

/*
 * Sample .dts fetches, cached by URL. The cache holds nulls too: a miss (old
 * tarball) is as cacheable as a hit, and StrictMode's double start reuses the
 * first answer either way.
 */
const fetchCache = new Map<string, string | null>()

async function fetchDtsText(assetUrl: string): Promise<string | null> {
  const cached = fetchCache.get(assetUrl)
  if (cached !== undefined) return cached
  let text: string | null = null
  try {
    const res = await fetch(assetUrl)
    // A dev/SPA server answers unknown paths with index.html and a 200, so a
    // usable answer needs the right shape, not just res.ok — same idea as the
    // asset probes in src/backends/. The /dts-v1/ sniff covers hosts that
    // serve everything as octet-stream.
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) {
      const body = await res.text()
      if (body.slice(0, 256).includes('/dts-v1/')) text = body
    }
  } catch {
    // Network failure reads as absence; the boot must not care.
  }
  fetchCache.set(assetUrl, text)
  return text
}

/**
 * Read a sample's .dts without touching the store — the gallery's devicetree
 * viewer peeks at samples that are not running. Shares the fetch cache.
 */
export function peekSampleDts(assetUrl: string): Promise<string | null> {
  return fetchDtsText(assetUrl)
}

let fetchEpoch = 0

/**
 * Fetch and install the devicetree shipped next to a bundled sample. Never
 * throws; an absent or malformed asset clears the store instead, which is the
 * pre-DTS behavior.
 *
 * Marks the store `pending` (and drops any previous tree) as soon as the fetch
 * starts, so the device dock does not paint the full static fallback for a
 * beat and then shrink to the sample's enabled nodes.
 *
 * Only the newest *state* wins: every mutation of the store — a newer sample
 * fetch, a user devicetree, a clear — bumps the epoch, so a fetch that was
 * still in flight when any of those happened (a sample's .dts queued behind
 * the multi-MB emulator assets, say, while the user drops their own ELF+DTS)
 * lands dead instead of clobbering the newer truth.
 */
export async function loadSampleDts(assetUrl: string, name: string): Promise<void> {
  const epoch = ++fetchEpoch
  // Drop the previous tree immediately so a sample switch cannot keep showing
  // the old inventory (or the packed fallback) while this fetch is in flight.
  const changed = current !== null || phase !== 'pending'
  current = null
  phase = 'pending'
  if (changed) notify()
  const text = await fetchDtsText(assetUrl)
  if (epoch !== fetchEpoch) return
  if (text === null) {
    current = null
    phase = 'absent'
  } else {
    current = build('sample', name, text)
    phase = 'ready'
  }
  notify()
}

/** Stash a user devicetree for the next document, alongside the stashed ELF. */
export async function stashUserDts(name: string, text: string): Promise<void> {
  await handoffTx('readwrite', (s) => s.put({ name, text }, DTS_KEY))
}

/** Drop any stashed devicetree, so a skipped prompt does not resurrect one. */
export async function clearStashedDts(): Promise<void> {
  try {
    await handoffTx('readwrite', (s) => s.delete(DTS_KEY))
  } catch {
    // Same storage failure the claim tolerates.
  }
}

/**
 * Reads the persisted user devicetree into this document. Leaves the IndexedDB
 * copy in place so Reload keeps it with the custom ELF; clear() drops both.
 */
export async function claimStashedDts(): Promise<void> {
  let record: { name: string; text: string } | undefined
  try {
    record = await handoffTx('readonly', (s) => s.get(DTS_KEY))
  } catch {
    return // private mode, blocked storage — fall back to no devicetree
  }
  if (!record) return
  fetchEpoch++ // a claimed handoff outranks any in-flight sample fetch
  current = build('user', record.name, record.text)
  phase = 'ready'
  notify()
}
