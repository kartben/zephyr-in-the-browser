import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LookSpec, TourStep } from '@/tours/parse'

/*
 * A look is a handful of calls into the dock and the debugger UI, so those are
 * what get faked: each call lands in `calls`, in order, and the three things
 * that decide whether Trace exists are plain variables a test can set.
 */

const calls: string[] = []
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
  getState: () => ({ seed: { primary: seed, expandAll: false } }),
  setTab: (key: string, tab: string) => calls.push(`setTab ${key} ${tab}`),
}))

vi.mock('@/lib/dockReveal', () => ({
  revealDockRow: (key: string) => calls.push(`revealDockRow ${key}`),
  revealPanelKind: (kind: string) => calls.push(`revealPanelKind ${kind}`),
}))

vi.mock('@/lib/debugUi', () => ({
  focusDebug: (section: string) => calls.push(`focusDebug ${section}`),
}))

vi.mock('@/lib/ipcUi', () => ({
  focusIpcObject: (name: string) => calls.push(`focusIpcObject ${name}`),
  clearIpcFilter: () => calls.push('clearIpcFilter'),
}))

const { NO_TRACE_NOTE, focusLook, focusStep, lookNotes } = await import('@/tours/look')

function step(panel: TourStep['panel'], look: LookSpec[]): Pick<TourStep, 'panel' | 'look'> {
  return { panel, look }
}

beforeEach(() => {
  calls.length = 0
  traceAvailable = false
  mode = 'sim'
  seed = []
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
  it('reveals the panel, then each look in the order written', () => {
    seed = ['trace']
    focusStep(
      step('led', [
        { kind: 'debug', section: 'cpu' },
        { kind: 'trace', tab: 'schedule' },
      ]),
    )
    expect(calls).toEqual([
      'revealPanelKind led',
      'focusDebug cpu',
      'setTab stage:trace schedule',
      'revealDockRow stage:trace',
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
    expect(calls).toEqual(['focusDebug objects'])
  })

  it.each([
    ['the guest is writing a trace', () => (traceAvailable = true)],
    ['a live board streams one', () => (mode = 'live')],
    ['the sample is a traced build', () => (seed = ['trace', 'debug'])],
  ])('opens Trace when %s', (_why, arrange) => {
    arrange()
    focusStep(step(null, [{ kind: 'trace', tab: 'queues' }]))
    expect(calls).toContain('revealDockRow stage:trace')
  })
})

describe('lookNotes', () => {
  it('says once that the view needs the traced build', () => {
    expect(lookNotes(step('trace', [{ kind: 'trace', tab: 'queues' }]))).toEqual([NO_TRACE_NOTE])
  })

  it('says nothing when Trace is there, or not asked for', () => {
    expect(lookNotes(step('gpio', [{ kind: 'debug', section: 'objects' }]))).toEqual([])
    seed = ['trace']
    expect(lookNotes(step(null, [{ kind: 'trace', tab: 'queues' }]))).toEqual([])
  })
})
