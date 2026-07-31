/**
 * Which network the guest's NIC is plugged into: the in-page simulated LAN
 * (default, needs nothing) or Bridge network via the desktop bridge / a
 * self-hosted passt gateway (docs/bridge.md, docs/net-gateway.md). One record
 * for the one NIC every board has today; the versioned-JSON shape leaves room
 * to key by interface later.
 *
 * Deliberately its own localStorage key (`zephyr.net`): connection config is
 * neither dock layout (survives "Reset layout") nor a per-sample seed
 * (survives board/sample switches). A `?net=` query param overrides the
 * stored choice for the session — `?net=sim` forces the sandbox, any
 * ws(s):// value forces the uplink — which is what the gateway's printed
 * deep link uses. When mode is uplink and Settings has a desktop bridge URL,
 * that URL wins so Network and Trace share one connection.
 */

import { resolveBridgeConfig, isValidBridgeUrl } from '@/lib/bridgeStore'

const STORAGE_KEY = 'zephyr.net'
const VERSION = 1

export const NET_QUERY_PARAM = 'net'

export type NetMode = 'sim' | 'uplink'

export interface NetSettings {
  mode: NetMode
  url: string
}

export interface ResolvedNetConfig extends NetSettings {
  source: 'default' | 'store' | 'query'
}

export function isValidGatewayUrl(url: string): boolean {
  if (!/^wss?:\/\//i.test(url)) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
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
      url: typeof parsed.url === 'string' && isValidGatewayUrl(parsed.url) ? parsed.url : '',
    }
  } catch {
    return defaults()
  }
}

function save(next: NetSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...next }))
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

function set(next: NetSettings) {
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

export function setUrl(url: string): void {
  if (state.url !== url) set({ ...state, url })
}

/**
 * What the next emulator session should plug into. Precedence:
 * `?net=` query > desktop bridge (when Settings is on) > stored settings >
 * default (sim). An unparseable query value is warned about and ignored.
 */
export function resolveNetConfig(search?: string): ResolvedNetConfig {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const q = new URLSearchParams(raw).get(NET_QUERY_PARAM)
  if (q !== null) {
    if (q === 'sim') return { mode: 'sim', url: state.url, source: 'query' }
    if (isValidGatewayUrl(q)) return { mode: 'uplink', url: q, source: 'query' }
    console.warn(`ignoring ?${NET_QUERY_PARAM}=${q}: expected "sim" or a ws(s):// URL`)
  }
  if (state.mode === 'uplink') {
    try {
      const bridge = resolveBridgeConfig(raw)
      if (bridge.enabled && isValidBridgeUrl(bridge.url)) {
        return { mode: 'uplink', url: bridge.url, source: hadStored ? 'store' : 'default' }
      }
    } catch {
      /* bridge store unavailable */
    }
  }
  return { ...state, source: hadStored ? 'store' : 'default' }
}

/** Re-read localStorage. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  state = load()
  notify()
}
