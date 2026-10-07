import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARDS, PANEL_KINDS, getBoard, getSample, type GuestSample } from '@/boards'
import { computeInsights, parseDts } from '@/dts'
import a53Shell from '@/dts/fixtures/qemu_cortex_a53_shell.dts?raw'
import { deriveDeviceInventory, type Availability, type DeviceNode } from '@/deviceTopology'
import { STAGE_DEBUG_KEY, STAGE_PERF_KEY, STAGE_TRACE_KEY } from '@/lib/dockStore'
import { tourInProgress, type TourState } from '@/tours/store'
import type { TourDoc } from '@/tours/parse'
import * as tryIt from './tryIt'

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
  tryIt.reloadFromStorage()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ALL: Availability = {
  gnss: true,
  bluetooth: true,
  gpio: true,
  audio: true,
  mic: true,
  net: true,
  i2c: true,
  spi: true,
  can: true,
  power: true,
  watchdog: true,
  display: true,
  input: true,
  disk: true,
}

type TourBits = Pick<TourState, 'enabled' | 'doc' | 'tourId' | 'finished'>
const NO_TOUR: TourBits = { enabled: true, doc: null, tourId: null, finished: false }
const A_TOUR = { steps: [] } as unknown as TourDoc

/** Every sample the page offers, with the board it is on. */
const everySample = BOARDS.flatMap((board) =>
  board.samples.map((sample) => ({ board, sample, selection: `${board.id}:${sample.id}` })),
)

describe('Try it lines', () => {
  it.each(everySample)('$selection has a line that fits the dock', ({ sample }) => {
    const line = tryIt.tryItLine(sample)
    expect(line.trim().length).toBeGreaterThan(0)
    // Two lines at the dock's default width, at most; one for a line of our own.
    expect(line.length).toBeLessThanOrEqual(90)
    if (sample.tryIt !== undefined && sample.tracedFrom === undefined) {
      expect(sample.tryIt.length).toBeLessThanOrEqual(64)
    }
    // Every `code` span is closed.
    expect(tryIt.splitCode(line).length % 2).toBe(1)
    expect(line).not.toContain(String.fromCharCode(0x2014)) // no em dashes
  })

  it('reads the description when there is no tryIt', () => {
    const button = getSample(getBoard('qemu_cortex_m3'), 'basic_button')
    expect(button.tryIt).toBeUndefined()
    expect(tryIt.tryItLine(button)).toBe(button.description)
  })

  it('gives a traced twin its base sample line, not the "Opens Trace and Debug" suffix', () => {
    const a53 = getBoard('qemu_cortex_a53')
    for (const twin of a53.samples.filter((s) => s.tracedFrom)) {
      const base = getSample(a53, twin.tracedFrom!)
      expect(tryIt.tryItLine(twin), twin.id).toBe(tryIt.tryItLine(base))
    }
  })

  it('names only real panel kinds', () => {
    for (const { selection, sample } of everySample) {
      for (const kind of sample.primaryPanels ?? []) {
        expect(PANEL_KINDS, selection).toContain(kind)
      }
    }
  })

  it('splits code spans out of a line', () => {
    expect(tryIt.splitCode('Type `help`, then `kernel threads`')).toEqual([
      'Type ',
      'help',
      ', then ',
      'kernel threads',
      '',
    ])
  })
})

describe('tryItFor', () => {
  it('speaks for a curated sample', () => {
    const hint = tryIt.tryItFor('qemu_cortex_m3:basic_button', new Set(), false)
    expect(hint?.sample.id).toBe('basic_button')
    expect(hint?.line).toContain('SW0')
  })

  it('says nothing for a Live board, a dropped ELF or an unknown sample', () => {
    for (const selection of ['', 'live', 'custom:zephyr.elf:', 'qemu_cortex_m3:no_such_sample']) {
      expect(tryIt.tryItFor(selection, new Set(), false), selection).toBeNull()
    }
  })

  it('stands aside while a tour is under way, and comes back once it is over', () => {
    const selection = 'qemu_cortex_a53:tracing_pipeline'
    const running: TourBits = { enabled: true, doc: A_TOUR, tourId: 'tracing_pipeline', finished: false }
    const hint = (tour: TourBits) => tryIt.tryItFor(selection, new Set(), tourInProgress(tour))
    expect(hint(running)).toBeNull()
    // Asked for and still loading: no flash of the hint before the intro card.
    expect(hint({ ...running, doc: null })).toBeNull()
    // Finished, or left (skip() finishes it too).
    expect(hint({ ...running, finished: true })).not.toBeNull()
    // Tours turned off: no card, so the hint is the guidance.
    expect(hint({ ...running, enabled: false })).not.toBeNull()
    // No tour for this sample.
    expect(hint(NO_TOUR)).not.toBeNull()
  })

  it('stays hidden for a dismissed selection only', () => {
    const dismissed = new Set(['qemu_cortex_m3:basic_button'])
    expect(tryIt.tryItFor('qemu_cortex_m3:basic_button', dismissed, false)).toBeNull()
    expect(tryIt.tryItFor('qemu_cortex_a53:basic_button', dismissed, false)).not.toBeNull()
  })
})

describe('tourInProgress', () => {
  it('holds for an enabled, unfinished tour, loaded or still loading', () => {
    const on: TourBits = { enabled: true, doc: A_TOUR, tourId: 'blinky', finished: false }
    expect(tourInProgress(on)).toBe(true)
    expect(tourInProgress({ ...on, doc: null })).toBe(true)
    expect(tourInProgress({ ...on, finished: true })).toBe(false)
    expect(tourInProgress({ ...on, enabled: false })).toBe(false)
    expect(tourInProgress(NO_TOUR)).toBe(false)
  })
})

describe('tryItTargets', () => {
  const kinds = (sample: GuestSample) => sample.primaryPanels ?? []

  it('maps the Cortex-M3 Button sample to its keys, LEDs and GPIO rows, in order', () => {
    const nodes = deriveDeviceInventory(null, [], [], ALL, 'qemu_cortex_m3').nodes
    const sample = getSample(getBoard('qemu_cortex_m3'), 'basic_button')
    const targets = tryIt.tryItTargets(kinds(sample), nodes)
    expect(targets.map((t) => t.kind)).toEqual(['keys', 'led', 'gpio'])
    expect(targets.map((t) => t.node?.label)).toEqual(['Buttons', 'LEDs', 'GPIO'])
    for (const target of targets) {
      const node = nodes.find((n) => n.key === target.key)
      expect(node?.presence).toBe('interactive')
      expect(target.deviceClass).toBe(node?.deviceClass)
    }
  })

  it('maps every panel the A53 shell names to a row of its devicetree', () => {
    const doc = parseDts(a53Shell)
    const tree = { name: 'shell.dts', doc, insights: computeInsights(doc) }
    const nodes = deriveDeviceInventory(tree, [], [], ALL, 'qemu_cortex_a53').nodes
    const sample = getSample(getBoard('qemu_cortex_a53'), 'shell')
    const targets = tryIt.tryItTargets(kinds(sample), nodes)
    const resolved = new Set(targets.map((t) => t.kind))
    // The buses and the speaker the tree declares. The character LCD is a
    // chip the page attaches at runtime, which this fixture does not have.
    for (const kind of ['i2c', 'spi', 'audio'] as const) expect(resolved).toContain(kind)
    for (const target of targets) {
      expect(nodes.find((n) => n.key === target.key)?.presence).toBe('interactive')
    }
  })

  it('finds instruments by their fixed keys, when they have something to show', () => {
    const twin = getSample(getBoard('qemu_cortex_a53'), 'blinky_trace')
    const all = tryIt.tryItTargets(kinds(twin), [])
    expect(all.map((t) => t.key)).toEqual([STAGE_TRACE_KEY, STAGE_DEBUG_KEY])
    const noTrace = tryIt.tryItTargets(kinds(twin), [], (kind) => kind !== 'trace')
    expect(noTrace.map((t) => t.key)).toEqual([STAGE_DEBUG_KEY])
  })

  it('prefers a device to an instrument for the same kind', () => {
    const power: DeviceNode = {
      key: 'rtc_cntl',
      nodeName: 'rtc_cntl',
      label: 'Power / RTC controller',
      deviceClass: 'power',
      path: '/soc/rtc_cntl',
      presence: 'interactive',
      panelKind: 'perf',
    }
    expect(tryIt.tryItTargets(['perf'], [power]).map((t) => t.key)).toEqual(['rtc_cntl'])
    expect(tryIt.tryItTargets(['perf'], []).map((t) => t.key)).toEqual([STAGE_PERF_KEY])
  })

  it('skips rows a reader cannot open, and gives two kinds on one row one chip', () => {
    const led = (key: string, presence: DeviceNode['presence']): DeviceNode => ({
      key,
      nodeName: key,
      label: key,
      deviceClass: 'led',
      path: `/${key}`,
      presence,
      panelKind: 'led',
    })
    expect(tryIt.tryItTargets(['led'], [led('ghost', 'ghost')])).toEqual([])
    expect(tryIt.tryItTargets(['led', 'led'], [led('a', 'interactive')]).map((t) => t.key)).toEqual(
      ['a'],
    )
    // A part this board does not have has no row, and so no chip.
    expect(tryIt.tryItTargets(['bluetooth'], [])).toEqual([])
  })
})

describe('dismissed hints', () => {
  it('starts with none', () => {
    expect(tryIt.getDismissed().size).toBe(0)
  })

  it('persists a dismissal per selection, and the way back clears it', () => {
    const listener = vi.fn()
    const unsubscribe = tryIt.subscribe(listener)
    tryIt.setTryItDismissed('qemu_cortex_m3:basic_button', true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('zephyr.tryIt')!)).toEqual({
      v: 1,
      dismissed: ['qemu_cortex_m3:basic_button'],
    })

    tryIt.reloadFromStorage()
    expect(tryIt.getDismissed().has('qemu_cortex_m3:basic_button')).toBe(true)
    expect(tryIt.getDismissed().has('qemu_cortex_a53:basic_button')).toBe(false)

    tryIt.setTryItDismissed('qemu_cortex_m3:basic_button', false)
    expect(tryIt.getDismissed().size).toBe(0)
    expect(localStorage.getItem('zephyr.tryIt')).toBeNull()
    unsubscribe()
  })

  it('does not notify for a change that changes nothing', () => {
    const listener = vi.fn()
    const unsubscribe = tryIt.subscribe(listener)
    tryIt.setTryItDismissed('qemu_cortex_m3:blinky', false)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('ignores a stored value it did not write', () => {
    localStorage.setItem('zephyr.tryIt', '{not json')
    tryIt.reloadFromStorage()
    expect(tryIt.getDismissed().size).toBe(0)
    localStorage.setItem('zephyr.tryIt', JSON.stringify({ v: 99, dismissed: ['a:b'] }))
    tryIt.reloadFromStorage()
    expect(tryIt.getDismissed().size).toBe(0)
  })

  it('still works with storage blocked, for this visit', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    tryIt.reloadFromStorage()
    expect(tryIt.getDismissed().size).toBe(0)
    expect(() => tryIt.setTryItDismissed('qemu_cortex_m3:blinky', true)).not.toThrow()
    expect(tryIt.getDismissed().has('qemu_cortex_m3:blinky')).toBe(true)
  })
})
