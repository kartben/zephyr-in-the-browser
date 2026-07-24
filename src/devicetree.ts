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
 *   in through `setUserDts`, and survives the reload a committed QEMU document
 *   forces via the same IndexedDB handoff the guest image uses (its own key,
 *   same store).
 *
 * Parse or insight failures degrade by stages: `doc: null` still shows raw
 * text in the viewer, `insights: null` sends every consumer to its hardcoded
 * fallback. Nothing here is allowed to make a boot worse than the pre-DTS
 * behavior.
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

let current: DeviceTreeState | null = null
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
  notify()
}

/** Forget the devicetree — e.g. when the guest changes under it. */
export function clear() {
  fetchEpoch++ // ...nor resurrect what was just cleared
  if (current === null) return
  current = null
  notify()
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
 * Only the newest *state* wins: every mutation of the store — a newer sample
 * fetch, a user devicetree, a clear — bumps the epoch, so a fetch that was
 * still in flight when any of those happened (a sample's .dts queued behind
 * the multi-MB emulator assets, say, while the user drops their own ELF+DTS)
 * lands dead instead of clobbering the newer truth.
 */
export async function loadSampleDts(assetUrl: string, name: string): Promise<void> {
  const epoch = ++fetchEpoch
  const text = await fetchDtsText(assetUrl)
  if (epoch !== fetchEpoch) return
  current = text === null ? null : build('sample', name, text)
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
 * Reads and clears the stashed devicetree. Called once at startup, before any
 * backend runs — the same one-shot contract as guestImage.claimStashed.
 */
export async function claimStashedDts(): Promise<void> {
  let record: { name: string; text: string } | undefined
  try {
    record = await handoffTx('readonly', (s) => s.get(DTS_KEY))
    if (record) await handoffTx('readwrite', (s) => s.delete(DTS_KEY))
  } catch {
    return // private mode, blocked storage — fall back to no devicetree
  }
  if (!record) return
  fetchEpoch++ // a claimed handoff outranks any in-flight sample fetch
  current = build('user', record.name, record.text)
  notify()
}
