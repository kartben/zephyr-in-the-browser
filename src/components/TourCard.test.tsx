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
  openIntro: vi.fn(),
  closeIntro: vi.fn(),
  minimise: vi.fn(),
  restore: vi.fn(),
  introReady: (s: TourState) => s.current !== null || s.waiting !== null || s.completed,
  // Only read for the dock's ring, which a static render never draws.
  cardOnScreen: () => null,
}))

vi.mock('@/debug/control', () => ({
  subscribe: () => () => {},
  getSnapshot: () => ({ paused: true, threads: [] }),
  step: vi.fn(),
}))

vi.mock('@/devicetree', () => ({ subscribe: () => () => {}, get: () => null }))

// The excerpt fetches its file; here it only shows what the card told it.
vi.mock('@/components/SourceSnippet', async () => {
  const { createElement } = await import('react')
  return {
    SourceSnippet: (props: { stop?: string; label?: string }) =>
      createElement('div', { 'data-snippet': props.stop ?? 'here', 'data-label': props.label }),
  }
})

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

const board = { id: 'qemu_cortex_a53', zephyrTarget: 'qemu_cortex_a53', samples: [] } as unknown as Board

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
    intro: null,
    armed: true,
    live: true,
    current: null,
    minimised: null,
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

  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  it('opens on its own card, with the title, the text before step 1 and the stops', () => {
    const html = render({ doc: withIntro, intro: 'first' })
    expect(html).toContain('data-tour-intro')
    expect(text(html)).toContain('Sensor pipeline')
    expect(text(html)).toContain('Three sensors feed an aggregator.')
    expect(text(html)).toContain('In this tour, 2 stops')
    expect(text(html)).toMatch(/1 Waits 2 Sends/)
  })

  it('waits for the first stop before it offers Start', () => {
    const html = render({ doc: withIntro, intro: 'first' })
    expect(html).toMatch(/<button[^>]*data-tour-start[^>]*disabled/)
    expect(text(html)).toContain('Waiting for the first stop')
  })

  it('offers Start over the first stop, without showing the step yet', () => {
    const stopped = { ...cardOf(0), paused: true }
    const html = render({ doc: withIntro, intro: 'first', current: stopped, seen: new Set([0]) })
    expect(html).not.toMatch(/<button[^>]*data-tour-start[^>]*disabled/)
    expect(text(html)).toMatch(/\sStart\s/)
    expect(text(html)).toContain('The guest is paused at the first stop')
    expect(html).not.toContain('data-tour-step')
    expect(html).not.toContain('First stop.')
  })

  it('starts where a `?step=` link entered', () => {
    const html = render({ doc: withIntro, intro: 'first', current: cardOf(1), startIndex: 1, seen: new Set([1]) })
    expect(text(html)).toContain('Start at stop 2')
    expect(text(html)).toContain('In this tour, 2 stops, from stop 2')
  })

  it('offers Back when opened again', () => {
    const html = render({ doc: withIntro, intro: 'again', current: cardOf(1), seen: new Set([0, 1]) })
    expect(text(html)).toMatch(/\sBack\s/)
    expect(html).not.toContain('data-tour-start')
  })

  it('leaves the step cards to the step, with the title in the header to open it again', () => {
    const html = render({ doc: withIntro, current: cardOf(0), seen: new Set([0]) })
    expect(html).toContain('data-tour-step="1"')
    expect(html).not.toContain('Three sensors')
    expect(html).toContain('read the intro again')
  })

  it('has no intro card, and no way back to one, for a tour with no intro', () => {
    const html = render({ intro: 'first', current: card(0), seen: new Set([0]) })
    expect(html).toContain('data-tour-step="1"')
    expect(html).not.toContain('data-tour-intro')
    expect(html).not.toContain('read the intro again')
  })
})

describe('TourCard minimised', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  it('offers to minimise, where the header used to offer to move on', () => {
    const html = render({ current: card(1), seen: new Set([0, 1]) })
    expect(html).toContain('aria-label="Minimise the card"')
    expect(html).not.toContain('Dismiss')
  })

  it('folds to one line: the step, its action, and the way back', () => {
    const shown = card(1)
    const html = render({ current: shown, minimised: shown, seen: new Set([0, 1]) })
    expect(html).toContain('data-tour-step="2"')
    expect(text(html)).toMatch(/2\/3 Main waits/)
    expect(text(html)).toMatch(/\sContinue\s/)
    expect(html).toContain('aria-label="Show the card"')
    expect(html).not.toContain('Minimise the card')
    expect(html).not.toContain('Leave the tour')
  })

  it('comes up whole for the next card', () => {
    const html = render({ current: card(2), minimised: card(1), seen: new Set([0, 1, 2]) })
    expect(html).toContain('Minimise the card')
    expect(html).toContain('Leave the tour')
  })
})

describe('TourCard views placed in the prose', () => {
  const withThreads = (body: string) =>
    parseTour(
      `## Sends\n\n\`\`\`tour\nat: main\nthreads: aggregator\n\`\`\`\n\n${body}\n`,
    )
  const shown = (d: ReturnType<typeof parseTour>) => ({ ...card(0), step: d.steps[0]!, threads: true })

  it('puts a view where its `{name}` line is', () => {
    const d = withThreads('About the code.\n\n{threads}\n\nAfter the list.')
    const html = render({ doc: d, current: shown(d), seen: new Set([0]) })
    const list = html.indexOf('No thread info')
    expect(list).toBeGreaterThan(html.indexOf('About the code.'))
    expect(list).toBeLessThan(html.indexOf('After the list.'))
  })

  it('keeps the usual order, under all the prose, without one', () => {
    const d = withThreads('About the code.\n\nAfter the list.')
    const html = render({ doc: d, current: shown(d), seen: new Set([0]) })
    expect(html.indexOf('No thread info')).toBeGreaterThan(html.indexOf('After the list.'))
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

describe('TourCard source excerpt', () => {
  /** A card stopped in main.c, with the file shipped. */
  const inMain = (index: number): TourCardState => ({
    ...card(index),
    anchor: { addr: 0x1000, via: 'line', file: '/src/main.c', line: 42, symbol: 'main' },
    source: 'main.c',
  })
  const snippet = (html: string) => /<div data-snippet="([^"]*)" data-label="([^"]*)"/.exec(html)?.slice(1)

  it('marks the stop on a step the guest is paused on', () => {
    expect(snippet(render({ current: inMain(1), seen: new Set([0, 1]) }))).toEqual(['here', 'main.c:42'])
  })

  it('claims no stop on a `stop: no` step, whose guest runs on', () => {
    expect(snippet(render({ current: inMain(0), seen: new Set([0]) }))).toEqual(['none', 'main.c:42'])
  })

  it('puts the stop in the past on a paused step read again', () => {
    const again = { ...inMain(1), paused: false, revisit: { back: card(2) } }
    expect(snippet(render({ current: again, seen: new Set([0, 1, 2]) }))).toEqual(['earlier', 'main.c:42'])
  })
})
