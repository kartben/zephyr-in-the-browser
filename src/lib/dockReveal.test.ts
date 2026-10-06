import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceInventory, DeviceNode } from '@/deviceTopology'

/*
 * Revealing a row is a few dockStore writes and a blink. The writes are what a
 * test can see, so dockStore is faked and records them; the blink waits two
 * animation frames for a DOM this environment does not have.
 */

const calls: string[] = []

vi.mock('@/lib/dockStore', () => ({
  STAGE_DEBUG_KEY: 'stage:debug',
  STAGE_PERF_KEY: 'stage:perf',
  STAGE_TRACE_KEY: 'stage:trace',
  getState: () => ({ view: 'classes', devices: {}, groups: {} }),
  setExpanded: (key: string, expanded: boolean) => calls.push(`setExpanded ${key} ${expanded}`),
  setGroupCollapsed: (group: string, collapsed: boolean) =>
    calls.push(`setGroupCollapsed ${group} ${collapsed}`),
  setHidden: (key: string, hidden: boolean) => calls.push(`setHidden ${key} ${hidden}`),
  showDock: () => calls.push('showDock'),
}))

const { publishInventory, revealPanelKind } = await import('@/lib/dockReveal')

function node(key: string, presence: DeviceNode['presence']): DeviceNode {
  return { key, nodeName: key, label: key, deviceClass: 'led', path: `/${key}`, presence, panelKind: 'led' }
}

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('requestAnimationFrame', () => 0)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('revealPanelKind', () => {
  it.each([
    ['trace', 'stage:trace'],
    ['debug', 'stage:debug'],
    ['perf', 'stage:perf'],
  ])('reveals the %s instrument row by its key', (kind, key) => {
    // Instruments are not in the devicetree inventory, so this used to be a
    // silent no-op for `panel: trace`.
    revealPanelKind(kind)
    expect(calls).toEqual(['showDock', `setExpanded ${key} true`])
  })

  it('finds a device row through the inventory, preferring a live one', () => {
    const inventory: DeviceInventory = {
      source: 'devicetree',
      nodes: [node('led-ghost', 'ghost'), node('led0', 'interactive')],
    }
    publishInventory(inventory)
    revealPanelKind('led')
    // Groups fold by default, so the reveal unfolds this one even untouched.
    expect(calls).toEqual(['showDock', 'setGroupCollapsed led false', 'setExpanded led0 true'])
  })

  it('does nothing for a kind this board has no row for', () => {
    publishInventory({ source: 'devicetree', nodes: [] })
    revealPanelKind('can')
    expect(calls).toEqual([])
  })
})
