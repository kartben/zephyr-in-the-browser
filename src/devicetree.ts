/** Running guest devicetree; parse/insight failures fall back by stage. */

import { computeInsights, parseDts } from '@/dts'
import type { DtsDocument, DtsInsights } from '@/dts'
import { handoffTx } from '@/guestImage'

const DTS_KEY = 'pending-guest-dts'

export interface DeviceTreeState {
  source: 'sample' | 'user'
  name: string
  text: string
  doc: DtsDocument | null
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

export function setUserDts(name: string, text: string) {
  fetchEpoch++ // a stale sample fetch must not clobber this
  current = build('user', name, text)
  notify()
}

export function clear() {
  fetchEpoch++ // ...nor resurrect what was just cleared
  if (current === null) return
  current = null
  notify()
}

// Cache misses too: older tarballs without .dts should not refetch every start.
const fetchCache = new Map<string, string | null>()

async function fetchDtsText(assetUrl: string): Promise<string | null> {
  const cached = fetchCache.get(assetUrl)
  if (cached !== undefined) return cached
  let text: string | null = null
  try {
    const res = await fetch(assetUrl)
    // Dev/SPA servers return index.html for misses; accept only real DTS text.
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

export function peekSampleDts(assetUrl: string): Promise<string | null> {
  return fetchDtsText(assetUrl)
}

let fetchEpoch = 0

/** Epoch rejects stale sample fetches after user DTS, clear, or newer sample. */
export async function loadSampleDts(assetUrl: string, name: string): Promise<void> {
  const epoch = ++fetchEpoch
  const text = await fetchDtsText(assetUrl)
  if (epoch !== fetchEpoch) return
  current = text === null ? null : build('sample', name, text)
  notify()
}

export async function stashUserDts(name: string, text: string): Promise<void> {
  await handoffTx('readwrite', (s) => s.put({ name, text }, DTS_KEY))
}

export async function clearStashedDts(): Promise<void> {
  try {
    await handoffTx('readwrite', (s) => s.delete(DTS_KEY))
  } catch {
    // Same storage failure the claim tolerates.
  }
}

/** Same one-shot reload handoff as guestImage.claimStashed. */
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
