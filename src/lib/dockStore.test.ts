import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as dock from './dockStore'
import { loadPanelLayout, migratePanelLayoutKeys, savePanelLayout } from './panelLayout'

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
  dock.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dockStore persistence', () => {
  it('starts from defaults when nothing is stored', () => {
    const state = dock.getState()
    expect(state.view).toBe('devicetree')
    expect(state.open).toBe(true)
    expect(state.width).toBe(dock.DOCK_DEFAULT_WIDTH)
    expect(state.devices).toEqual({})
  })

  it('round-trips through storage', () => {
    dock.setView('classes')
    dock.setWidth(25)
    dock.setOpen(false)
    dock.setExpanded('virtio_i2c0:48', true)
    dock.setHidden('net', true)
    dock.setWindowed('virtio_i2c0:50', true)
    dock.toggleGroup('sensor')

    dock.reloadFromStorage()
    const state = dock.getState()
    expect(state.view).toBe('classes')
    expect(state.width).toBe(25)
    expect(state.open).toBe(false)
    expect(state.devices['virtio_i2c0:48']).toEqual({ expanded: true })
    expect(state.devices['net']).toEqual({ hidden: true })
    expect(state.devices['virtio_i2c0:50']).toEqual({ windowed: true })
    expect(dock.groupCollapsed('sensor')).toBe(true)
    expect(dock.groupCollapsed('net')).toBe(false)
  })

  it('discards a stored blob with the wrong version or bad JSON', () => {
    localStorage.setItem('zephyr.dock', JSON.stringify({ v: 999, view: 'classes' }))
    dock.reloadFromStorage()
    expect(dock.getState().view).toBe('devicetree')

    localStorage.setItem('zephyr.dock', '{not json')
    dock.reloadFromStorage()
    expect(dock.getState().view).toBe('devicetree')
  })

  it('clamps the width', () => {
    dock.setWidth(50)
    expect(dock.getState().width).toBe(dock.DOCK_MAX_WIDTH)
    dock.setWidth(1)
    expect(dock.getState().width).toBe(dock.DOCK_MIN_WIDTH)
  })

  it('clearing a hidden/windowed flag drops the record entirely', () => {
    dock.setHidden('net', true)
    dock.setHidden('net', false)
    expect(dock.getState().devices['net']).toBeUndefined()
  })

  it('round-trips body sections and reads them with per-section defaults', () => {
    expect(dock.sectionOpenIn(dock.getState(), 'net', 'status', true)).toBe(true)
    expect(dock.sectionOpenIn(dock.getState(), 'net', 'capture', false)).toBe(false)

    dock.setSection('net', 'capture', true)
    dock.setSection('net', 'status', false)
    dock.reloadFromStorage()

    expect(dock.sectionOpenIn(dock.getState(), 'net', 'capture', false)).toBe(true)
    expect(dock.sectionOpenIn(dock.getState(), 'net', 'status', true)).toBe(false)
    // Sections coexist with the other per-device flags.
    dock.setHidden('net', true)
    expect(dock.getState().devices['net']).toEqual({
      hidden: true,
      sections: { capture: true, status: false },
    })
  })
})

describe('seeding and expansion precedence', () => {
  it('follows the seed until the user overrides', () => {
    dock.seedForSelection('qemu_cortex_a53:sensors', { primary: ['sensor'], expandAll: false })

    expect(dock.effectiveExpanded('virtio_i2c0:48', 'sensor')).toBe(true)
    expect(dock.effectiveExpanded('net', 'net')).toBe(false)
    expect(dock.effectiveExpanded('uart0', undefined)).toBe(false)

    dock.setExpanded('net', true)
    expect(dock.effectiveExpanded('net', 'net')).toBe(true)
    dock.setExpanded('virtio_i2c0:48', false)
    expect(dock.effectiveExpanded('virtio_i2c0:48', 'sensor')).toBe(false)
  })

  it('expandAll (custom ELF without a tree) expands everything interactive', () => {
    dock.seedForSelection('custom:blob.elf', { primary: [], expandAll: true })
    expect(dock.effectiveExpanded('net', 'net')).toBe(true)
    expect(dock.effectiveExpanded('gnss', 'gnss')).toBe(true)
    dock.setExpanded('net', false)
    expect(dock.effectiveExpanded('net', 'net')).toBe(false)
  })

  it('keeps overrides on a same-selection reseed, clears them on a new one', () => {
    dock.seedForSelection('a53:shell', { primary: ['i2c'], expandAll: false })
    dock.setExpanded('net', true)
    dock.setHidden('gnss', true)
    dock.setWindowed('virtio_i2c0:50', true)

    dock.seedForSelection('a53:shell', { primary: ['i2c'], expandAll: false })
    expect(dock.effectiveExpanded('net', 'net')).toBe(true)

    dock.seedForSelection('a53:display', { primary: ['display'], expandAll: false })
    // Expansion reverts to the new sample's defaults…
    expect(dock.effectiveExpanded('net', 'net')).toBe(false)
    // …but what the user hid or popped out is about their screen, and stays.
    expect(dock.isHidden('gnss')).toBe(true)
    expect(dock.isWindowed('virtio_i2c0:50')).toBe(true)
  })

  it('effectiveExpandedIn is pure over an explicit state', () => {
    const state = dock.getState()
    const seeded = {
      ...state,
      seed: { primary: ['gpio' as const], expandAll: false },
      devices: { x: { expanded: false } },
    }
    expect(dock.effectiveExpandedIn(seeded, 'gpio', 'gpio')).toBe(true)
    expect(dock.effectiveExpandedIn(seeded, 'x', 'gpio')).toBe(false)
    expect(dock.effectiveExpandedIn(seeded, 'y', undefined)).toBe(false)
  })
})

describe('legacy panel-layout key migration', () => {
  it('moves geometry to the new per-bus keys and drops perf', () => {
    savePanelLayout('sensor:48', { floating: true, rect: { x: 1, y: 2, w: 300, h: 200 } })
    savePanelLayout('memory:50', { floating: true, rect: { x: 5, y: 6, w: 400, h: 300 } })
    savePanelLayout('oled', { floating: true, rect: { x: 7, y: 8, w: 200, h: 100 } })
    savePanelLayout('perf', { floating: true, rect: { x: 0, y: 0, w: 200, h: 100 } })
    savePanelLayout('net', { floating: true, rect: { x: 9, y: 9, w: 500, h: 400 } })

    migratePanelLayoutKeys()

    expect(loadPanelLayout('virtio_i2c0:48')?.rect).toEqual({ x: 1, y: 2, w: 300, h: 200 })
    expect(loadPanelLayout('virtio_i2c0:50')?.rect).toEqual({ x: 5, y: 6, w: 400, h: 300 })
    expect(loadPanelLayout('virtio_i2c0:3c')?.rect).toEqual({ x: 7, y: 8, w: 200, h: 100 })
    expect(loadPanelLayout('sensor:48')).toBeNull()
    expect(loadPanelLayout('perf')).toBeNull()
    expect(loadPanelLayout('net')?.rect).toEqual({ x: 9, y: 9, w: 500, h: 400 })
  })

  it('never clobbers geometry already saved under a new key', () => {
    savePanelLayout('sensor:48', { floating: true, rect: { x: 1, y: 1, w: 100, h: 100 } })
    savePanelLayout('virtio_i2c0:48', { floating: true, rect: { x: 2, y: 2, w: 200, h: 200 } })

    migratePanelLayoutKeys()

    expect(loadPanelLayout('virtio_i2c0:48')?.rect).toEqual({ x: 2, y: 2, w: 200, h: 200 })
    expect(loadPanelLayout('sensor:48')).toBeNull()
  })
})

describe('resetLayout', () => {
  it('drops dock state and float boxes but keeps the current seed', () => {
    dock.seedForSelection('a53:shell', { primary: ['i2c'], expandAll: false })
    dock.setView('classes')
    dock.setHidden('net', true)
    savePanelLayout('net', { floating: true, rect: { x: 9, y: 9, w: 500, h: 400 } })

    dock.resetLayout()

    expect(dock.getState().view).toBe('devicetree')
    expect(dock.isHidden('net')).toBe(false)
    expect(loadPanelLayout('net')).toBeNull()
    expect(dock.effectiveExpanded('virtio_i2c0', 'i2c')).toBe(true)
  })
})
