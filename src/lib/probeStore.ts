/**
 * Live-board probe bridge settings (docs/probe-bridge.md).
 *
 * Separate localStorage key from net (`zephyr.probe`): Trace's Live board
 * connection is not dock layout and not a per-sample seed. `?probe=` overrides
 * for the session — that is what the daemon's printed deep link uses.
 */

const STORAGE_KEY = 'zephyr.probe'
const VERSION = 1

export const PROBE_QUERY_PARAM = 'probe'

export type ProbeMode = 'off' | 'bridge'

export interface ProbeSettings {
  mode: ProbeMode
  url: string
}

export interface ResolvedProbeConfig extends ProbeSettings {
  source: 'default' | 'store' | 'query'
}

export function isValidProbeUrl(url: string): boolean {
  if (!/^wss?:\/\//i.test(url)) return false
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function defaults(): ProbeSettings {
  return { mode: 'off', url: '' }
}

let hadStored = false

function load(): ProbeSettings {
  hadStored = false
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as { v?: number } & Partial<ProbeSettings>
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return defaults()
    hadStored = true
    return {
      mode: parsed.mode === 'bridge' ? 'bridge' : 'off',
      url: typeof parsed.url === 'string' && isValidProbeUrl(parsed.url) ? parsed.url : '',
    }
  } catch {
    return defaults()
  }
}

function save(next: ProbeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...next }))
    hadStored = true
  } catch {
    /* storage full or blocked */
  }
}

let state: ProbeSettings = load()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function set(next: ProbeSettings) {
  state = next
  save(next)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSettings(): ProbeSettings {
  return state
}

export function setMode(mode: ProbeMode): void {
  if (state.mode !== mode) set({ ...state, mode })
}

export function setUrl(url: string): void {
  if (state.url !== url) set({ ...state, url })
}

/**
 * Precedence: `?probe=` query > stored settings > default (off).
 * `?probe=off` forces off; any ws(s):// value forces bridge.
 */
export function resolveProbeConfig(search?: string): ResolvedProbeConfig {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search)
  const q = new URLSearchParams(raw).get(PROBE_QUERY_PARAM)
  if (q !== null) {
    if (q === 'off') return { mode: 'off', url: state.url, source: 'query' }
    if (isValidProbeUrl(q)) return { mode: 'bridge', url: q, source: 'query' }
    console.warn(`ignoring ?${PROBE_QUERY_PARAM}=${q}: expected "off" or a ws(s):// URL`)
  }
  return { ...state, source: hadStored ? 'store' : 'default' }
}

export function reloadFromStorage(): void {
  state = load()
  notify()
}

/** Same mixed-content hint as the net uplink. */
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
    /* invalid — caller validates separately */
  }
  return ''
}

export const PROBE_ONE_LINER = 'cd probe && npm install && npm start'

export const PROBE_DOCKER_ONE_LINER =
  'docker run --rm -p 8740:8740 --device=/dev/ttyACM0 -e SERIAL=/dev/ttyACM0 ghcr.io/kartben/zephyr-in-the-browser/probe'
