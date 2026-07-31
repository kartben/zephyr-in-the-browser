/**
 * The session's orientation: run Zephyr apps in the in-page Simulator, or
 * attach to a Live board through the desktop bridge. One global mode — it
 * decides what the stage shows (terminal vs. live-board home), which dock
 * rows exist, and who owns the Trace decoder. The bridge connection itself is
 * orthogonal: a Simulator session may keep the bridge connected for Bridge
 * network, which is why this is not derived from `zephyr.bridge`.
 *
 * Deliberately its own localStorage key (`zephyr.mode`), like `zephyr.net`.
 * Query params are read once at document start (`resolveModeConfig`) and then
 * the mode is fixed for the document's life — mode changes navigate with an
 * explicit `?mode=`, so the top-bar switch never becomes a dead control the
 * way a query-forced setting would.
 */

import { BRIDGE_QUERY_PARAM, isValidBridgeUrl } from '@/lib/bridgeStore'

const STORAGE_KEY = 'zephyr.mode'
const VERSION = 1

export const MODE_QUERY_PARAM = 'mode'

export type SessionMode = 'sim' | 'live'

export interface ResolvedModeConfig {
  mode: SessionMode
  source: 'default' | 'store' | 'query' | 'bridge-link' | 'sample-link'
}

/** True when load() restored an actual stored record (drives `source`). */
let hadStored = false

function load(): SessionMode {
  hadStored = false
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return 'sim'
    const parsed = JSON.parse(raw) as { v?: number; mode?: string }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return 'sim'
    if (parsed.mode !== 'sim' && parsed.mode !== 'live') return 'sim'
    hadStored = true
    return parsed.mode
  } catch {
    return 'sim'
  }
}

function save(mode: SessionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, mode }))
    hadStored = true
  } catch {
    /* storage full or blocked — the navigation's ?mode= still carries intent */
  }
}

/** The stored preference (what a plain URL resolves to next visit). */
let stored: SessionMode = load()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * What this document's session targets. Precedence, highest first:
 *
 *  1. `?mode=sim|live` — explicit, always wins (invalid values warn and fall
 *     through).
 *  2. `?bridge=<ws(s) URL>` → live: the bridge TUI's deep link means "attach
 *     to my board", even when the address bar still carries a board/app pair
 *     from an earlier Simulator visit. `?bridge=off` implies nothing.
 *  3. `?board=` / `?app=` → sim: a shared sample link must open the sample
 *     even for a visitor whose stored mode is live.
 *  4. Stored `zephyr.mode`.
 *  5. `sim` — the zero-friction demo default.
 */
export function resolveModeConfig(search?: string): ResolvedModeConfig {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const params = new URLSearchParams(raw)

  const q = params.get(MODE_QUERY_PARAM)
  if (q !== null) {
    if (q === 'sim' || q === 'live') return { mode: q, source: 'query' }
    console.warn(`ignoring ?${MODE_QUERY_PARAM}=${q}: expected "sim" or "live"`)
  }

  const bridge = params.get(BRIDGE_QUERY_PARAM)
  if (bridge !== null && isValidBridgeUrl(bridge)) return { mode: 'live', source: 'bridge-link' }

  if (params.has('board') || params.has('app')) return { mode: 'sim', source: 'sample-link' }

  return { mode: stored, source: hadStored ? 'store' : 'default' }
}

/** Resolved once at document start; fixed until the next navigation. */
let sessionMode: SessionMode = resolveModeConfig().mode

/** The current session's mode. Stable primitive, safe for useSyncExternalStore. */
export function getMode(): SessionMode {
  return sessionMode
}

/**
 * Set the session mode and persist it as the preference. Callers that need
 * the change to take effect (App's mode switch) navigate afterwards — a
 * committed QEMU document cannot be recycled, so the switch always reloads.
 */
export function setMode(mode: SessionMode): void {
  if (sessionMode === mode && stored === mode) return
  sessionMode = mode
  stored = mode
  save(mode)
  notify()
}

/** Re-read localStorage and re-resolve. For tests and external storage edits. */
export function reloadFromStorage(): void {
  stored = load()
  sessionMode = resolveModeConfig().mode
  notify()
}
