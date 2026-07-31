import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bridgeStore from './bridgeStore'

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
  bridgeStore.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bridgeStore', () => {
  it('defaults to disabled', () => {
    expect(bridgeStore.getSettings()).toEqual({ enabled: false, url: '' })
  })

  it('persists enabled URL', () => {
    bridgeStore.setEnabled(true)
    bridgeStore.setUrl('ws://localhost:8740/?token=abc')
    bridgeStore.reloadFromStorage()
    expect(bridgeStore.getSettings()).toEqual({
      enabled: true,
      url: 'ws://localhost:8740/?token=abc',
    })
  })

  it('?bridge= forces session config', () => {
    const url = 'ws://localhost:8740/?token=x'
    const cfg = bridgeStore.resolveBridgeConfig(`?bridge=${encodeURIComponent(url)}`)
    expect(cfg).toEqual({ enabled: true, url, source: 'query' })
    expect(bridgeStore.getSettings().enabled).toBe(false)
  })

  it('migrates legacy zephyr.probe', () => {
    localStorage.setItem(
      'zephyr.probe',
      JSON.stringify({ v: 1, mode: 'bridge', url: 'ws://legacy:8740/' }),
    )
    bridgeStore.reloadFromStorage()
    expect(bridgeStore.getSettings()).toEqual({
      enabled: true,
      url: 'ws://legacy:8740/',
    })
  })
})
