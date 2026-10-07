import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceInventory, DeviceNode } from '@/deviceTopology'

/*
 * Revealing a row is a few dockStore writes and a blink. The writes are what a
 * test can see, so dockStore is faked and records them; the blink waits two
 * animation frames for a DOM this environment does not have.
 */

const calls: string[] = []
const view = { current: 'classes' }
/** What the sample is about: the fold holds every other device row. */
let primary: string[] = []

vi.mock('@/lib/dockStore', () => ({
  STAGE_DEBUG_KEY: 'stage:debug',
  STAGE_PERF_KEY: 'stage:perf',
  STAGE_TRACE_KEY: 'stage:trace',
  getState: () => ({
    view: view.current,
    devices: {},
    groups: {},
    seed: { primary, expandAll: false },
  }),
  setMoreOpen: (open: boolean) => calls.push(`setMoreOpen ${open}`),
  setExpanded: (key: string, expanded: boolean) => calls.push(`setExpanded ${key} ${expanded}`),
  setGroupCollapsed: (group: string, collapsed: boolean) =>
    calls.push(`setGroupCollapsed ${group} ${collapsed}`),
  setHidden: (key: string, hidden: boolean) => calls.push(`setHidden ${key} ${hidden}`),
  setView: (next: string) => {
    view.current = next
    calls.push(`setView ${next}`)
  },
  showDock: () => calls.push('showDock'),
}))

const { publishInventory, revealDockRow, revealPanelKind } = await import('@/lib/dockReveal')

function node(key: string, presence: DeviceNode['presence']): DeviceNode {
  return { key, nodeName: key, label: key, deviceClass: 'led', path: `/${key}`, presence, panelKind: 'led' }
}

beforeEach(() => {
  calls.length = 0
  view.current = 'classes'
  primary = []
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
    // A row the sample is not about sits in the closed "More on this board"
    // fold, inside a class group that is folded too: the reveal opens both.
    expect(calls).toEqual([
      'showDock',
      'setMoreOpen true',
      'setGroupCollapsed led false',
      'setExpanded led0 true',
    ])
  })

  it('leaves the fold alone for a row the sample leads with', () => {
    primary = ['led']
    publishInventory({ source: 'devicetree', nodes: [node('led0', 'interactive')] })
    revealPanelKind('led')
    expect(calls).toEqual(['showDock', 'setExpanded led0 true'])
  })

  it('does nothing for a kind this board has no row for', () => {
    publishInventory({ source: 'devicetree', nodes: [] })
    revealPanelKind('can')
    expect(calls).toEqual([])
  })
})

describe('revealDockRow', () => {
  it('shows a row the ▤ view leaves out in the devicetree view', () => {
    publishInventory({
      source: 'devicetree',
      nodes: [
        {
          key: 'uart1',
          nodeName: 'uart@4000d000',
          label: 'uart1',
          deviceClass: 'uart-bus',
          path: '/soc/uart@4000d000',
          presence: 'inert',
        },
        node('led0', 'interactive'),
      ],
    })
    revealDockRow('uart1', 'uart-bus')
    expect(calls).toEqual(['showDock', 'setView devicetree', 'setExpanded uart1 true'])

    // A row it does list is revealed where it is: with no sample to lead
    // with, that is the "More on this board" fold, which opens.
    calls.length = 0
    view.current = 'classes'
    revealDockRow('led0', 'led')
    expect(calls).toEqual([
      'showDock',
      'setMoreOpen true',
      'setGroupCollapsed led false',
      'setExpanded led0 true',
    ])
  })
})
