/**
 * Global desktop bridge settings — one WebSocket URL for net + CTF + GDB.
 *
 * Persists under `zephyr.bridge`. Supersedes separate net/probe URLs in the UI;
 * Network and Trace read this store. `?bridge=` overrides for the session.
 */

const STORAGE_KEY = 'zephyr.bridge'
const VERSION = 1

export const BRIDGE_QUERY_PARAM = 'bridge'

export interface BridgeSettings {
  /** When true and url is set, the page connects the uber bridge. */
  enabled: boolean
  url: string
}

export interface ResolvedBridgeConfig extends BridgeSettings {
  source: 'default' | 'store' | 'query'
}

export function isValidBridgeUrl(url: string): boolean {
  if (!/^wss?:\/\//i.test(url)) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function defaults(): BridgeSettings {
  return { enabled: false, url: '' }
}

let hadStored = false

function load(): BridgeSettings {
  hadStored = false
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return migrateLegacy()
    const parsed = JSON.parse(raw) as { v?: number } & Partial<BridgeSettings>
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return migrateLegacy()
    hadStored = true
    return {
      enabled: parsed.enabled === true,
      url: typeof parsed.url === 'string' && isValidBridgeUrl(parsed.url) ? parsed.url : '',
    }
  } catch {
    return defaults()
  }
}

/** One-shot pull from older zephyr.net / zephyr.probe keys. */
function migrateLegacy(): BridgeSettings {
  try {
    const probe = localStorage.getItem('zephyr.probe')
    if (probe) {
      const p = JSON.parse(probe) as { mode?: string; url?: string }
      if (p?.mode === 'bridge' && typeof p.url === 'string' && isValidBridgeUrl(p.url)) {
        const next = { enabled: true, url: p.url }
        save(next)
        hadStored = true
        return next
      }
    }
    const net = localStorage.getItem('zephyr.net')
    if (net) {
      const n = JSON.parse(net) as { mode?: string; url?: string }
      if (n?.mode === 'uplink' && typeof n.url === 'string' && isValidBridgeUrl(n.url)) {
        const next = { enabled: true, url: n.url }
        save(next)
        hadStored = true
        return next
      }
    }
  } catch {
    /* ignore */
  }
  return defaults()
}

function save(next: BridgeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...next }))
    hadStored = true
  } catch {
    /* storage full or blocked */
  }
}

let state: BridgeSettings = typeof localStorage === 'undefined' ? defaults() : load()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function set(next: BridgeSettings) {
  state = next
  save(next)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSettings(): BridgeSettings {
  return state
}

export function setEnabled(enabled: boolean): void {
  if (state.enabled !== enabled) set({ ...state, enabled })
}

export function setUrl(url: string): void {
  if (state.url !== url) set({ ...state, url })
}

export function setSettings(partial: Partial<BridgeSettings>): void {
  const next = {
    enabled: partial.enabled ?? state.enabled,
    url: partial.url ?? state.url,
  }
  if (next.enabled === state.enabled && next.url === state.url) return
  set(next)
}

/**
 * Precedence: `?bridge=` > stored. `?bridge=off` forces disabled;
 * any ws(s):// enables and sets the URL for the session (not written until save).
 */
export function resolveBridgeConfig(search?: string): ResolvedBridgeConfig {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const q = new URLSearchParams(raw).get(BRIDGE_QUERY_PARAM)
  if (q !== null) {
    if (q === 'off') return { enabled: false, url: state.url, source: 'query' }
    if (isValidBridgeUrl(q)) return { enabled: true, url: q, source: 'query' }
    console.warn(`ignoring ?${BRIDGE_QUERY_PARAM}=${q}: expected "off" or a ws(s):// URL`)
  }
  return { ...state, source: hadStored ? 'store' : 'default' }
}

export function reloadFromStorage(): void {
  state = load()
  notify()
}

export function mixedContentHint(url: string): string {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return ''
  try {
    const u = new URL(url)
    if (u.protocol === 'ws:') {
      const host = u.hostname
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
        return 'This page is https; some browsers block ws:// even to localhost. Use a wss:// URL if Connect fails.'
      }
      return 'This page is https; browsers block ws:// to remote hosts. Use a wss:// URL.'
    }
  } catch {
    /* invalid */
  }
  return ''
}

/** Native install — best for USB serial (especially macOS / Windows). */
export const BRIDGE_NATIVE_ONE_LINER = 'cd bridge && npm install && npm start'

/**
 * Docker: great for real network (passt). USB serial needs Linux + --device;
 * Docker Desktop on Mac/Windows generally cannot see serial adapters.
 */
export const BRIDGE_DOCKER_ONE_LINER =
  'docker run --rm -p 8740:8740 ghcr.io/kartben/zephyr-in-the-browser/bridge'

export const BRIDGE_DOCKER_SERIAL_ONE_LINER =
  'docker run --rm -p 8740:8740 --device=/dev/ttyACM0 -e SERIAL=/dev/ttyACM0 ghcr.io/kartben/zephyr-in-the-browser/bridge'
