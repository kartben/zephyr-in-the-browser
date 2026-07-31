import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as netStore from './netStore'
import * as bridgeStore from './bridgeStore'

/** Minimal Storage for the node test environment. */
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
  netStore.reloadFromStorage()
  bridgeStore.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('netStore', () => {
  it('defaults to the simulated LAN', () => {
    expect(netStore.getSettings()).toEqual({ mode: 'sim', url: '' })
  })

  it('persists mode across a reload (URL lives in Settings)', () => {
    netStore.setMode('uplink')
    netStore.reloadFromStorage()
    expect(netStore.getSettings()).toEqual({ mode: 'uplink', url: '' })
    expect(localStorage.getItem('zephyr.net')).toContain('"v":1')
  })

  it('sanitizes corrupt or foreign stored values', () => {
    for (const raw of [
      'not json',
      '{"v":99,"mode":"uplink","url":"ws://x/"}',
      '{"v":1,"mode":"tap","url":"ws://x/"}',
    ]) {
      localStorage.setItem('zephyr.net', raw)
      netStore.reloadFromStorage()
      const s = netStore.getSettings()
      expect(['sim', 'uplink']).toContain(s.mode)
      expect(s.url).toBe('')
    }
    localStorage.setItem('zephyr.net', '{"v":1,"mode":"uplink","url":"nope"}')
    netStore.reloadFromStorage()
    expect(netStore.getSettings()).toEqual({ mode: 'uplink', url: '' })
  })

  describe('resolveNetConfig precedence', () => {
    it('?net=sim forces the sandbox over a stored uplink', () => {
      netStore.setMode('uplink')
      const cfg = netStore.resolveNetConfig('?net=sim')
      expect(cfg.mode).toBe('sim')
      expect(cfg.source).toBe('query')
    })

    it('?net=uplink forces Bridge network without touching the store', () => {
      const cfg = netStore.resolveNetConfig('?net=uplink')
      expect(cfg.mode).toBe('uplink')
      expect(cfg.source).toBe('query')
      expect(netStore.getSettings().mode).toBe('sim')
    })

    it('uplink URL comes from Settings desktop bridge', () => {
      netStore.setMode('uplink')
      bridgeStore.setEnabled(true)
      bridgeStore.setUrl('ws://localhost:8740/?token=abc')
      const cfg = netStore.resolveNetConfig('')
      expect(cfg).toEqual({
        mode: 'uplink',
        url: 'ws://localhost:8740/?token=abc',
        source: 'store',
      })
    })

    it('uplink with Settings off has an empty URL', () => {
      netStore.setMode('uplink')
      const cfg = netStore.resolveNetConfig('')
      expect(cfg.mode).toBe('uplink')
      expect(cfg.url).toBe('')
    })

    it('legacy ?net=<ws-url> forces uplink and warns to use Settings', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const cfg = netStore.resolveNetConfig('?net=ws://gw.example/')
      expect(cfg.mode).toBe('uplink')
      expect(cfg.url).toBe('')
      expect(cfg.source).toBe('query')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('an invalid query value warns and falls through to the store', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      netStore.setMode('uplink')
      const cfg = netStore.resolveNetConfig('?net=http://nope/')
      expect(cfg.mode).toBe('uplink')
      expect(cfg.source).toBe('store')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('labels the source: default with nothing stored, store afterwards', () => {
      expect(netStore.resolveNetConfig('').source).toBe('default')
      netStore.setMode('uplink')
      expect(netStore.resolveNetConfig('').source).toBe('store')
    })
  })
})
