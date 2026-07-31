/**
 * Which network the guest's NIC is plugged into: the in-page simulated LAN
 * (default, needs nothing) or Bridge network via the desktop bridge in
 * Settings (docs/bridge.md). One record for the one NIC every board has
 * today; the versioned-JSON shape leaves room to key by interface later.
 *
 * Deliberately its own localStorage key (`zephyr.net`): mode is neither dock
 * layout (survives "Reset layout") nor a per-sample seed (survives board/sample
 * switches). The bridge URL lives only in Settings (`zephyr.bridge`). A
 * `?net=sim` / `?net=uplink` query overrides the stored mode for the session.
 */

import { resolveBridgeConfig, isValidBridgeUrl } from '@/lib/bridgeStore'

const STORAGE_KEY = 'zephyr.net'
const VERSION = 1

export const NET_QUERY_PARAM = 'net'

export type NetMode = 'sim' | 'uplink'

export interface NetSettings {
  mode: NetMode
  /** @deprecated Kept for storage back-compat; URL comes from Settings. */
  url: string
}

export interface ResolvedNetConfig extends NetSettings {
  source: 'default' | 'store' | 'query'
}

function defaults(): NetSettings {
  return { mode: 'sim', url: '' }
}

/** True when load() restored an actual stored record (drives `source`). */
let hadStored = false

function load(): NetSettings {
  hadStored = false
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as { v?: number } & Partial<NetSettings>
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return defaults()
    hadStored = true
    return {
      mode: parsed.mode === 'uplink' ? 'uplink' : 'sim',
      url: '',
    }
  } catch {
    return defaults()
  }
}

function save(next: NetSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, mode: next.mode, url: '' }))
    hadStored = true
  } catch {
    /* storage full or blocked — the choice just won't survive the reload */
  }
}

let state: NetSettings = load()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function set(next: NetSettings): void {
  state = next
  save(next)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Immutable snapshot; a new object on every change (useSyncExternalStore). */
export function getSettings(): NetSettings {
  return state
}

export function setMode(mode: NetMode): void {
  if (state.mode !== mode) set({ ...state, mode })
}

/**
 * What the next emulator session should plug into. Precedence:
 * `?net=` query > stored mode > default (sim). Uplink URL always comes from
 * the desktop bridge in Settings (`?bridge=` / zephyr.bridge).
 */
export function resolveNetConfig(search?: string): ResolvedNetConfig {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const q = new URLSearchParams(raw).get(NET_QUERY_PARAM)

  let mode: NetMode = state.mode
  let source: ResolvedNetConfig['source'] = hadStored ? 'store' : 'default'

  if (q !== null) {
    if (q === 'sim') {
      mode = 'sim'
      source = 'query'
    } else if (q === 'uplink') {
      mode = 'uplink'
      source = 'query'
    } else if (/^wss?:\/\//i.test(q)) {
      // Legacy deep links from the old net-only gateway. Mode only; URL is Settings.
      console.warn(
        `ignoring gateway URL in ?${NET_QUERY_PARAM}=…: use Settings (or ?bridge=) for the desktop bridge`,
      )
      mode = 'uplink'
      source = 'query'
    } else {
      console.warn(`ignoring ?${NET_QUERY_PARAM}=${q}: expected "sim" or "uplink"`)
    }
  }

  const bridge = resolveBridgeConfig(raw)
  const url =
    mode === 'uplink' && bridge.enabled && isValidBridgeUrl(bridge.url) ? bridge.url : ''

  return { mode, url, source }
}

/** Re-read localStorage. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  state = load()
  notify()
}
