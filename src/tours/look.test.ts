import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDockTargets, setDockTargets } from '@/lib/dockTarget'
import type { LookSpec, TourStep } from '@/tours/parse'

/*
 * A look is a handful of calls into the dock and the debugger UI, so those are
 * what get faked: each call lands in `calls`, in order, and the three things
 * that decide whether Trace exists are plain variables a test can set. A quiet
 * reveal, one that leaves the blink to the card, says so.
 */

const calls: string[] = []
/** Dock rows by the panel kind they stand for, as the inventory would have them. */
const rows = new Map<string, string>([
  ['trace', 'stage:trace'],
  ['debug', 'stage:debug'],
  ['led', 'gpio-leds'],
  ['keys', 'gpio-keys'],
])
const quiet = (opts?: { quiet?: boolean }) => (opts?.quiet ? ' quiet' : '')
let traceAvailable = false
let mode: 'sim' | 'live' = 'sim'
let seed: string[] = []

vi.mock('@/hostTrace', () => ({
  getSnapshot: () => ({ available: traceAvailable }),
}))

vi.mock('@/lib/modeStore', () => ({
  getMode: () => mode,
}))

vi.mock('@/lib/dockStore', () => ({
  STAGE_TRACE_KEY: 'stage:trace',
  STAGE_DEBUG_KEY: 'stage:debug',
  getState: () => ({ seed: { primary: seed, expandAll: false } }),
  setTab: (key: string, tab: string) => calls.push(`setTab ${key} ${tab}`),
}))

vi.mock('@/lib/dockReveal', () => ({
  revealDockRow: (key: string, _cls?: string, opts?: { quiet?: boolean }) =>
    calls.push(`revealDockRow ${key}${quiet(opts)}`),
  revealPanelKind: (kind: string, opts?: { quiet?: boolean }) =>
    calls.push(`revealPanelKind ${kind}${quiet(opts)}`),
  panelKindRow: (kind: string) => {
    const key = rows.get(kind)
    return key ? { key } : null
  },
  blinkDockRow: (key: string) => calls.push(`blinkDockRow ${key}`),
}))

vi.mock('@/lib/debugUi', () => ({
  focusDebug: (section: string, opts?: { quiet?: boolean }) =>
    calls.push(`focusDebug ${section}${quiet(opts)}`),
}))

/** The IPC filter's name and focus, and who listens for them to change. */
let ipcFilter: { focusName: string | null; focus: string | null } = { focusName: null, focus: null }
const ipcListeners = new Set<() => void>()
function setIpcFilter(next: typeof ipcFilter) {
  ipcFilter = next
  for (const fn of [...ipcListeners]) fn()
}

vi.mock('@/lib/ipcUi', () => ({
  focusIpcObject: (name: string) => calls.push(`focusIpcObject ${name}`),
  clearIpcFilter: () => calls.push('clearIpcFilter'),
  getSnapshot: () => ipcFilter,
  subscribe: (fn: () => void) => {
    ipcListeners.add(fn)
    return () => ipcListeners.delete(fn)
  },
}))

const { BLINK_AFTER_MS, focusLook, focusStep, lookNotes, lookTargets, pointAt } =
  await import('@/tours/look')

function step(panel: TourStep['panel'], look: LookSpec[]): Pick<TourStep, 'panel' | 'look'> {
  return { panel, look }
}

beforeEach(() => {
  calls.length = 0
  traceAvailable = false
  mode = 'sim'
  seed = []
  setDockTargets([])
})

describe('focusLook', () => {
  it('opens Trace on the tab the step names', () => {
    focusLook({ kind: 'trace', tab: 'net' })
    // The tab is set before the row expands, so it opens onto it.
    expect(calls).toEqual(['setTab stage:trace net', 'revealDockRow stage:trace'])
  })

  it('opens the whole IPC graph, whatever the reader had narrowed it to', () => {
    focusLook({ kind: 'trace', tab: 'queues' })
    expect(calls).toEqual(['setTab stage:trace queues', 'clearIpcFilter', 'revealDockRow stage:trace'])
  })

  it('focuses the IPC graph on the object the step names', () => {
    focusLook({ kind: 'trace', tab: 'queues', focus: 'bus_mutex' })
    expect(calls).toEqual([
      'setTab stage:trace queues',
      'focusIpcObject bus_mutex',
      'revealDockRow stage:trace',
    ])
  })

  it('hands a Debug section to the Debug row', () => {
    focusLook({ kind: 'debug', section: 'objects' })
    expect(calls).toEqual(['focusDebug objects'])
  })

  it('treats a dock target the way `panel:` is treated', () => {
    focusLook({ kind: 'dock', panel: 'gpio' })
    expect(calls).toEqual(['revealPanelKind gpio'])
  })
})

describe('focusStep', () => {
  it('reveals the panel, then each look in the order written, all quietly', () => {
    seed = ['trace']
    focusStep(
      step('led', [
        { kind: 'debug', section: 'cpu' },
        { kind: 'trace', tab: 'schedule' },
      ]),
    )
    // Quietly: the card is about to land, and blinks the rows once it has.
    expect(calls).toEqual([
      'revealPanelKind led quiet',
      'focusDebug cpu quiet',
      'setTab stage:trace schedule',
      'revealDockRow stage:trace quiet',
    ])
  })

  it('skips Trace on a guest that has none, and opens the rest', () => {
    focusStep(
      step('trace', [
        { kind: 'trace', tab: 'queues' },
        { kind: 'dock', panel: 'trace' },
        { kind: 'debug', section: 'objects' },
      ]),
    )
    expect(calls).toEqual(['focusDebug objects quiet'])
  })

  it.each([
    ['the guest is writing a trace', () => (traceAvailable = true)],
    ['a live board streams one', () => (mode = 'live')],
    ['the sample is a traced build', () => (seed = ['trace', 'debug'])],
  ])('opens Trace when %s', (_why, arrange) => {
    arrange()
    focusStep(step(null, [{ kind: 'trace', tab: 'queues' }]))
    expect(calls).toContain('revealDockRow stage:trace quiet')
  })
})

describe('lookTargets', () => {
  it('names the row and the tab inside it for Trace and Debug', () => {
    expect(
      lookTargets(
        step(null, [
          { kind: 'trace', tab: 'queues', focus: 'sensor_q' },
          { kind: 'debug', section: 'threads' },
        ]),
      ),
    ).toEqual([
      { key: 'stage:trace', tab: 'queues' },
      { key: 'stage:debug', tab: 'threads' },
    ])
  })

  it('names the row a `panel:` or a dock look stands for, and nothing inside it', () => {
    expect(lookTargets(step('keys', [{ kind: 'dock', panel: 'led' }]))).toEqual([
      { key: 'gpio-keys' },
      { key: 'gpio-leds' },
    ])
  })

  it('names a row once, and skips a part this board has no row for', () => {
    expect(
      lookTargets(
        step('led', [
          { kind: 'dock', panel: 'led' },
          { kind: 'dock', panel: 'pwm' },
        ]),
      ),
    ).toEqual([{ key: 'gpio-leds' }])
  })

  it('names Trace on a guest that has none: there is no row to ring until there is', () => {
    expect(lookTargets(step(null, [{ kind: 'trace', tab: 'schedule' }]))).toEqual([
      { key: 'stage:trace', tab: 'schedule' },
    ])
  })

  it('names nothing for a step that looks at nothing', () => {
    expect(lookTargets(step(null, []))).toEqual([])
  })
})

describe('pointAt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    ipcFilter = { focusName: null, focus: null }
    ipcListeners.clear()
  })

  const ipc = step('trace', [{ kind: 'trace', tab: 'queues' }])
  const sensorQ = step(null, [{ kind: 'trace', tab: 'queues', focus: 'sensor_q' }])

  it('rings what the step points at as its card lands, and blinks it once the card is up', () => {
    pointAt(ipc)
    expect(getDockTargets()).toEqual([{ key: 'stage:trace' }, { key: 'stage:trace', tab: 'queues' }])
    // Nothing blinks under the card's own arrival.
    vi.advanceTimersByTime(BLINK_AFTER_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    // One blink per row, however many tabs of it the step names.
    expect(calls).toEqual(['blinkDockRow stage:trace'])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual(['blinkDockRow stage:trace'])
    expect(getDockTargets()).toHaveLength(2)
  })

  it('clears the ring when the card goes, and does not blink after it', () => {
    const undo = pointAt(step('led', []))
    expect(getDockTargets()).toEqual([{ key: 'gpio-leds' }])
    undo()
    expect(getDockTargets()).toEqual([])
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    expect(calls).toEqual([])
  })

  it('moves the ring to the next card, and blinks only the rows that one points at', () => {
    const undo = pointAt(step('led', []))
    undo()
    pointAt(step(null, [{ kind: 'debug', section: 'threads' }]))
    expect(getDockTargets()).toEqual([{ key: 'stage:debug', tab: 'threads' }])
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    expect(calls).toEqual(['blinkDockRow stage:debug'])
  })

  it('rings an IPC object with no traffic yet, but does not blink it', () => {
    ipcFilter = { focusName: 'sensor_q', focus: null }
    pointAt(sensorQ)
    expect(getDockTargets()).toEqual([{ key: 'stage:trace', tab: 'queues' }])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual([])
  })

  it('blinks the IPC object once it turns up while the card is still there', () => {
    ipcFilter = { focusName: 'sensor_q', focus: null }
    pointAt(sensorQ)
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    setIpcFilter({ focusName: null, focus: 'object:1' })
    expect(calls).toEqual(['blinkDockRow stage:trace'])
    setIpcFilter({ focusName: null, focus: 'object:2' })
    expect(calls).toEqual(['blinkDockRow stage:trace'])
  })

  it('does not blink when the reader clears the filter, or after the card goes', () => {
    ipcFilter = { focusName: 'sensor_q', focus: null }
    pointAt(sensorQ)
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    setIpcFilter({ focusName: null, focus: null })
    setIpcFilter({ focusName: null, focus: 'object:1' })
    ipcFilter = { focusName: 'sensor_q', focus: null }
    const undo = pointAt(sensorQ)
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    undo()
    setIpcFilter({ focusName: null, focus: 'object:1' })
    expect(calls).toEqual([])
  })

  it('still blinks the rest of a step whose IPC object has no traffic yet', () => {
    ipcFilter = { focusName: 'sensor_q', focus: null }
    pointAt(step('led', [{ kind: 'trace', tab: 'queues', focus: 'sensor_q' }]))
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    expect(calls).toEqual(['blinkDockRow gpio-leds'])
    ipcFilter = { focusName: 'sensor_q', focus: null }
    calls.length = 0
    pointAt(step(null, [{ kind: 'trace', tab: 'schedule' }, { kind: 'trace', tab: 'queues', focus: 'sensor_q' }]))
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    expect(calls).toEqual(['blinkDockRow stage:trace'])
  })

  it('rings nothing for a card that points at nothing, or for no card', () => {
    setDockTargets([{ key: 'gpio-leds' }])
    pointAt(step(null, []))()
    expect(getDockTargets()).toEqual([])
    setDockTargets([{ key: 'gpio-leds' }])
    pointAt(null)
    expect(getDockTargets()).toEqual([])
    vi.advanceTimersByTime(BLINK_AFTER_MS)
    expect(calls).toEqual([])
  })
})

describe('lookNotes', () => {
  it('says once that the view needs the traced build', () => {
    expect(lookNotes(step('trace', [{ kind: 'trace', tab: 'queues' }]))).toEqual([
      'This view needs the traced build of this sample.',
    ])
  })

  it('says nothing when Trace is there, or not asked for', () => {
    expect(lookNotes(step('gpio', [{ kind: 'debug', section: 'objects' }]))).toEqual([])
    seed = ['trace']
    expect(lookNotes(step(null, [{ kind: 'trace', tab: 'queues' }]))).toEqual([])
  })
})
