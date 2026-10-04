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

/** The card as rendered, over a store in `state`. */
function render(state: Partial<TourState>): string {
  tour.state = {
    doc,
    tourId: 'basic_button',
    startIndex: 0,
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
  return renderToStaticMarkup(<TourCard board={board} sampleId="basic_button" />)
}

/** The card's root element, as rendered: the attributes are what the harness reads. */
function root(state: Partial<TourState>): string {
  const html = render(state)
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

describe('TourCard links', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ')

  it('offers a link to the step on screen', () => {
    expect(render({ current: card(1), seen: new Set([1]) })).toContain(
      'aria-label="Copy a link to this step"',
    )
  })

  it('says where a `?step=` link started the tour, on the first card only', () => {
    const first = render({ current: card(1), startIndex: 1, seen: new Set([1]) })
    expect(text(first)).toContain('Started at step 2')
    const later = render({ current: card(2), startIndex: 1, seen: new Set([1, 2]) })
    expect(text(later)).not.toContain('Started at')
    const fromTop = render({ current: card(1), seen: new Set([0, 1]) })
    expect(text(fromTop)).not.toContain('Started at')
  })

  it('says it on the your-turn card when that is the first card', () => {
    const waiting = { index: 2, text: 'Press **SW0**.', do: [], notes: [] }
    expect(text(render({ waiting, startIndex: 2 }))).toContain('Started at step 3')
  })
})

describe('TourCard intro', () => {
  const withIntro = parseTour(
    [
      '---\ntour: Sensor pipeline\nsample: samples/subsys/tracing/pipeline\n---\n',
      'Three sensors feed an aggregator.\n',
      '## Waits\n\n```tour\nat: main\n```\n\nFirst stop.\n',
      '## Sends\n\n```tour\nat: main.c:42\n```\n\nSecond stop.\n',
    ].join('\n'),
  )
  const cardOf = (index: number): TourCardState => ({ ...card(0), step: withIntro.steps[index]! })

  it('opens the first card with the tour title and the text before step 1', () => {
    const html = render({ doc: withIntro, current: cardOf(0), seen: new Set([0]) })
    expect(html).toContain('data-tour-intro')
    expect(html).toContain('Sensor pipeline')
    expect(html).toContain('Three sensors feed an aggregator.')
    expect(html.indexOf('Three sensors')).toBeLessThan(html.indexOf('First stop.'))
  })

  it('leaves it off the cards after', () => {
    const html = render({ doc: withIntro, current: cardOf(1), seen: new Set([0, 1]) })
    expect(html).not.toContain('data-tour-intro')
  })

  it('puts it on the step a `?step=` link entered at', () => {
    const html = render({ doc: withIntro, current: cardOf(1), startIndex: 1, seen: new Set([1]) })
    expect(html).toContain('Three sensors feed an aggregator.')
  })

  it('shows nothing extra for a tour with no intro', () => {
    expect(render({ current: card(0), seen: new Set([0]) })).not.toContain('data-tour-intro')
  })
})

describe('TourCard on a step read again', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ')

  it('offers Back, not what the step offered when it fired', () => {
    // Step 2 failed a check it retries when it fired, and is read again over step 3.
    const fired = { ...card(1), check: { rows: [], outcome: 'failed' as const, retrying: true } }
    const html = render({
      current: { ...fired, paused: false, revisit: { back: card(2) } },
      seen: new Set([0, 1, 2]),
    })
    expect(text(html)).toMatch(/\sBack\s/)
    expect(text(html)).not.toMatch(/Try again|Continue|Got it/)
    expect(html).not.toContain('data-tour-paused')
  })
})
