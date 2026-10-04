import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Board } from '@/boards'
import { parseTour } from '@/tours/parse'
import type { TourCard as TourCardState, TourState } from '@/tours/store'

/*
 * What the headless playthrough (tools/tour-playthrough.mjs) waits on: which
 * card is up, for which step, and whether the guest is paused under it. The
 * cards' content has tests of its own; this pins the data-tour-* handles, read
 * through TourCard's own choice of card.
 */

const tour = vi.hoisted(() => ({ state: null as unknown }))

vi.mock('@/tours/store', () => ({
  getSnapshot: () => tour.state,
  subscribe: () => () => {},
  next: vi.fn(),
  skip: vi.fn(),
  revisit: vi.fn(),
  dismissCompletion: vi.fn(),
  fetchTour: vi.fn(async () => null),
}))

vi.mock('@/debug/control', () => ({
  subscribe: () => () => {},
  getSnapshot: () => ({ paused: true, threads: [] }),
  step: vi.fn(),
}))

vi.mock('@/devicetree', () => ({ subscribe: () => () => {}, get: () => null }))

const { TourCard } = await import('./TourCard')

const doc = parseTour(
  [
    '---\ntour: Button\nsample: samples/basic/button\n---\n',
    '## Main starts\n\n```tour\nat: main\nstop: no\n```\n\nProse.\n',
    '## Main waits\n\n```tour\nat: main.c:42\n```\n\nProse.\n',
    '## A press\n\n```tour\nat: button_input_cb\nawait: Press **SW0**.\nci: press sw0\n```\n\nProse.\n',
    '## Done\n\nThe end.\n',
  ].join('\n'),
)

const board = { id: 'qemu_cortex_a53', samples: [] } as unknown as Board

function card(index: number): TourCardState {
  const step = doc.steps[index]!
  return {
    step,
    anchor: null,
    paused: step.stop,
    hits: 1,
    values: [],
    check: null,
    memory: null,
    objects: null,
    registers: [],
    threads: false,
    highlight: [],
    lookNotes: [],
    source: null,
    provenance: null,
  }
}

/** The card's root element, as rendered: the attributes are what the harness reads. */
function root(state: Partial<TourState>): string {
  tour.state = {
    doc,
    enabled: true,
    armed: true,
    live: true,
    current: null,
    waiting: null,
    seen: new Set<number>(),
    finished: false,
    completed: false,
    problems: [],
    ...state,
  } satisfies TourState
  const html = renderToStaticMarkup(<TourCard board={board} sampleId="basic_button" />)
  return /^<div[^>]*>/.exec(html)?.[0] ?? html
}

describe('TourCard data-tour-* attributes', () => {
  it('numbers a step card from 1 and says when the guest is paused under it', () => {
    const tag = root({ current: card(1) })
    expect(tag).toContain('data-tour-step="2"')
    expect(tag).toContain('data-tour-paused=""')
    expect(tag).not.toContain('data-tour-waiting')
  })

  it('leaves the paused mark off a card the guest runs on under', () => {
    const tag = root({ current: card(0) })
    expect(tag).toContain('data-tour-step="1"')
    expect(tag).not.toContain('data-tour-paused')
  })

  it('marks the your-turn card with the step it waits on', () => {
    const tag = root({ waiting: { index: 2, text: 'Press **SW0**.', do: [], notes: [] } })
    expect(tag).toContain('data-tour-step="3"')
    expect(tag).toContain('data-tour-waiting=""')
  })

  it('marks the completion card, which belongs to no step', () => {
    const tag = root({ finished: true, completed: true })
    expect(tag).toContain('data-tour-complete=""')
    expect(tag).not.toContain('data-tour-step')
  })

  it('renders nothing between cards', () => {
    expect(root({ armed: true })).toBe('')
  })
})
