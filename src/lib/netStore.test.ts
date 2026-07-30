import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as netStore from './netStore'

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
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('netStore', () => {
  it('defaults to the simulated LAN with no URL', () => {
    expect(netStore.getSettings()).toEqual({ mode: 'sim', url: '' })
  })

  it('persists mode and URL across a reload', () => {
    netStore.setMode('uplink')
    netStore.setUrl('wss://gw.example/net?token=abc')
    netStore.reloadFromStorage()
    expect(netStore.getSettings()).toEqual({
      mode: 'uplink',
      url: 'wss://gw.example/net?token=abc',
    })
    expect(localStorage.getItem('zephyr.net')).toContain('"v":1')
  })

  it('sanitizes corrupt or foreign stored values', () => {
    for (const raw of [
      'not json',
      '{"v":99,"mode":"uplink","url":"ws://x/"}',
      '{"v":1,"mode":"tap","url":"ws://x/"}',
      '{"v":1,"mode":"uplink","url":"http://x/"}',
    ]) {
      localStorage.setItem('zephyr.net', raw)
      netStore.reloadFromStorage()
      const s = netStore.getSettings()
      expect(['sim', 'uplink']).toContain(s.mode)
      expect(s.url === '' || netStore.isValidGatewayUrl(s.url)).toBe(true)
    }
    // The one salvageable field survives: a valid mode with a bad URL.
    localStorage.setItem('zephyr.net', '{"v":1,"mode":"uplink","url":"nope"}')
    netStore.reloadFromStorage()
    expect(netStore.getSettings()).toEqual({ mode: 'uplink', url: '' })
  })

  it('validates gateway URLs as ws:// or wss:// only', () => {
    expect(netStore.isValidGatewayUrl('ws://localhost:8737')).toBe(true)
    expect(netStore.isValidGatewayUrl('wss://x.trycloudflare.com/?token=a')).toBe(true)
    expect(netStore.isValidGatewayUrl('WSS://UPPER.example')).toBe(true)
    expect(netStore.isValidGatewayUrl('http://localhost:8737')).toBe(false)
    expect(netStore.isValidGatewayUrl('ws://')).toBe(false)
    expect(netStore.isValidGatewayUrl('')).toBe(false)
    expect(netStore.isValidGatewayUrl('localhost:8737')).toBe(false)
  })

  describe('resolveNetConfig precedence', () => {
    it('?net=sim forces the sandbox over a stored uplink', () => {
      netStore.setMode('uplink')
      netStore.setUrl('ws://gw/')
      const cfg = netStore.resolveNetConfig('?net=sim')
      expect(cfg.mode).toBe('sim')
      expect(cfg.source).toBe('query')
    })

    it('?net=<url> forces the uplink without touching the store', () => {
      const url = 'wss://gw.example/net?token=abc'
      const cfg = netStore.resolveNetConfig(`?net=${encodeURIComponent(url)}`)
      expect(cfg).toEqual({ mode: 'uplink', url, source: 'query' })
      expect(netStore.getSettings().mode).toBe('sim')
    })

    it('an invalid query value warns and falls through to the store', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      netStore.setMode('uplink')
      netStore.setUrl('ws://stored/')
      const cfg = netStore.resolveNetConfig('?net=http://nope/')
      expect(cfg.mode).toBe('uplink')
      expect(cfg.url).toBe('ws://stored/')
      expect(cfg.source).toBe('store')
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('labels the source: default with nothing stored, store afterwards', () => {
      expect(netStore.resolveNetConfig('').source).toBe('default')
      netStore.setUrl('ws://gw/')
      expect(netStore.resolveNetConfig('').source).toBe('store')
    })
  })
})
