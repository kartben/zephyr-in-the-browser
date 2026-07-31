import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as modeStore from './modeStore'

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
  modeStore.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('modeStore', () => {
  it('defaults to the Simulator', () => {
    expect(modeStore.getMode()).toBe('sim')
    expect(modeStore.resolveModeConfig('')).toEqual({ mode: 'sim', source: 'default' })
  })

  it('persists the mode across a reload', () => {
    modeStore.setMode('live')
    modeStore.reloadFromStorage()
    expect(modeStore.getMode()).toBe('live')
    expect(localStorage.getItem('zephyr.mode')).toContain('"v":1')
  })

  it('sanitizes corrupt or foreign stored values', () => {
    for (const raw of ['not json', '{"v":99,"mode":"live"}', '{"v":1,"mode":"hardware"}']) {
      localStorage.setItem('zephyr.mode', raw)
      modeStore.reloadFromStorage()
      expect(modeStore.getMode()).toBe('sim')
      expect(modeStore.resolveModeConfig('').source).toBe('default')
    }
  })

  it('labels the source: default with nothing stored, store afterwards', () => {
    expect(modeStore.resolveModeConfig('').source).toBe('default')
    modeStore.setMode('live')
    expect(modeStore.resolveModeConfig('')).toEqual({ mode: 'live', source: 'store' })
  })

  describe('resolveModeConfig precedence', () => {
    it('?mode=live forces live without touching the store', () => {
      const cfg = modeStore.resolveModeConfig('?mode=live')
      expect(cfg).toEqual({ mode: 'live', source: 'query' })
      expect(localStorage.getItem('zephyr.mode')).toBeNull()
    })

    it('?mode=sim beats a stored live preference', () => {
      modeStore.setMode('live')
      expect(modeStore.resolveModeConfig('?mode=sim')).toEqual({ mode: 'sim', source: 'query' })
    })

    it('an invalid ?mode= warns and falls through to the store', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      modeStore.setMode('live')
      expect(modeStore.resolveModeConfig('?mode=hardware')).toEqual({
        mode: 'live',
        source: 'store',
      })
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('the bridge deep link implies live', () => {
      const cfg = modeStore.resolveModeConfig('?bridge=ws%3A%2F%2Flocalhost%3A8740%2F%3Ftoken%3Dabc')
      expect(cfg).toEqual({ mode: 'live', source: 'bridge-link' })
    })

    it('?bridge=off and invalid bridge URLs imply nothing', () => {
      modeStore.setMode('live')
      expect(modeStore.resolveModeConfig('?bridge=off').source).toBe('store')
      expect(modeStore.resolveModeConfig('?bridge=http://nope/').source).toBe('store')
    })

    it('a shared sample link opens the Simulator even for a stored-live visitor', () => {
      modeStore.setMode('live')
      expect(modeStore.resolveModeConfig('?board=qemu_cortex_a53&app=blinky')).toEqual({
        mode: 'sim',
        source: 'sample-link',
      })
      expect(modeStore.resolveModeConfig('?app=blinky')).toEqual({
        mode: 'sim',
        source: 'sample-link',
      })
    })

    it('?mode=sim&bridge=… stays in the Simulator (uplink demo links)', () => {
      expect(modeStore.resolveModeConfig('?mode=sim&bridge=ws://localhost:8740/')).toEqual({
        mode: 'sim',
        source: 'query',
      })
    })

    it('?bridge=…&board=… lands in live: the deep link outranks a stale selection', () => {
      expect(
        modeStore.resolveModeConfig('?bridge=ws://localhost:8740/&board=qemu_cortex_a53'),
      ).toEqual({ mode: 'live', source: 'bridge-link' })
    })
  })
})
