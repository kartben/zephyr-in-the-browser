import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as probeStore from './probeStore'

class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  probeStore.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeStore', () => {
  it('defaults to off', () => {
    expect(probeStore.getSettings()).toEqual({ mode: 'off', url: '' })
  })

  it('persists bridge mode and URL', () => {
    probeStore.setMode('bridge')
    probeStore.setUrl('ws://localhost:8740/?token=abc')
    probeStore.reloadFromStorage()
    expect(probeStore.getSettings()).toEqual({
      mode: 'bridge',
      url: 'ws://localhost:8740/?token=abc',
    })
  })

  it('validates probe URLs as ws:// or wss:// only', () => {
    expect(probeStore.isValidProbeUrl('ws://localhost:8740')).toBe(true)
    expect(probeStore.isValidProbeUrl('wss://x.example/?token=a')).toBe(true)
    expect(probeStore.isValidProbeUrl('http://localhost:8740')).toBe(false)
    expect(probeStore.isValidProbeUrl('')).toBe(false)
  })

  describe('resolveProbeConfig precedence', () => {
    it('?probe=off forces off over a stored bridge', () => {
      probeStore.setMode('bridge')
      probeStore.setUrl('ws://probe/')
      const cfg = probeStore.resolveProbeConfig('?probe=off')
      expect(cfg).toEqual({ mode: 'off', url: 'ws://probe/', source: 'query' })
    })

    it('?probe=<url> forces the bridge without touching the store', () => {
      const url = 'ws://localhost:8740/?token=x'
      const cfg = probeStore.resolveProbeConfig(`?probe=${encodeURIComponent(url)}`)
      expect(cfg).toEqual({ mode: 'bridge', url, source: 'query' })
      expect(probeStore.getSettings().mode).toBe('off')
    })
  })
})
