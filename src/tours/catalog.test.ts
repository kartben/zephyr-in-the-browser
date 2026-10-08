import { describe, expect, it } from 'vitest'
import type { Board } from '@/boards'
import {
  defaultTourFor,
  hasTour,
  loadTourSource,
  nextSampleId,
  sampleForTour,
  tourIds,
  tourNeedsTrace,
  toursForApp,
  toursOn,
  tourToRun,
  tracedBuildOf,
} from '@/tours/catalog'
import { parseTour } from '@/tours/parse'
import { tourNeedsTrace as markdownNeedsTrace } from '@/tours/traits'

/** Only the app list matters to where a `next:` lands. */
function board(...ids: string[]): Board {
  return { samples: ids.map((id) => ({ id })) } as unknown as Board
}

/** Any board: the made-up tours below point at nothing, so no board hides one. */
const ANY = board()

/** A catalog where one app has three tours. The real one has one each, so far. */
const IDS = ['basic_button', 'basic_button.msgq', 'basic_button.debounce', 'blinky', 'philosophers']

describe('nextSampleId', () => {
  it('lands on the app the tour is named after', () => {
    expect(nextSampleId(board('blinky', 'basic_button'), 'blinky', 'basic_button')).toBe('basic_button')
  })

  it('keeps a reader on a traced twin on the next one', () => {
    const a53 = board('blinky', 'blinky_trace', 'basic_button', 'basic_button_trace')
    expect(nextSampleId(a53, 'blinky_trace', 'basic_button')).toBe('basic_button_trace')
    expect(nextSampleId(a53, 'blinky', 'basic_button')).toBe('basic_button')
  })

  it('lands on the traced twin for a tour that points at Trace', () => {
    const a53 = board('msg_queue', 'msg_queue_trace', 'msgq_lab', 'msgq_lab_trace')
    expect(nextSampleId(a53, 'msg_queue', 'msgq_lab')).toBe('msgq_lab_trace')
  })

  it('is null for a tour that points at Trace on a board with no traced build', () => {
    expect(nextSampleId(board('msg_queue', 'msgq_lab'), 'msg_queue', 'msgq_lab')).toBeNull()
  })

  it('falls back to the plain app when the next one has no traced twin', () => {
    expect(nextSampleId(board('blinky_trace', 'basic_button'), 'blinky_trace', 'basic_button')).toBe(
      'basic_button',
    )
  })

  it('is null when this board does not offer the next app', () => {
    expect(nextSampleId(board('msg_queue'), 'msg_queue', 'msgq_lab')).toBeNull()
  })

  it('lands on the app of another tour named by its full id', () => {
    const a53 = board('blinky', 'blinky_trace', 'basic_button', 'basic_button_trace')
    expect(nextSampleId(a53, 'blinky', 'basic_button.msgq')).toBe('basic_button')
    expect(nextSampleId(a53, 'blinky_trace', 'basic_button.msgq')).toBe('basic_button_trace')
  })
})

describe('toursForApp', () => {
  it('lists the default tour first, then the others by name', () => {
    expect(toursForApp('basic_button', IDS)).toEqual([
      'basic_button',
      'basic_button.debounce',
      'basic_button.msgq',
    ])
  })

  it("gives a traced twin its base sample's tours", () => {
    expect(toursForApp('basic_button_trace', IDS)).toEqual(toursForApp('basic_button', IDS))
  })

  it('does not take a longer app id for a tour of a shorter one', () => {
    expect(toursForApp('basic', ['basic_button', 'basic.extra'])).toEqual(['basic.extra'])
  })

  it('reads tours/ itself when given no list', () => {
    expect(toursForApp('blinky')).toEqual(['blinky', 'blinky.code'])
    expect(toursForApp('shell')).toEqual([])
    expect(hasTour(board('philosophers', 'philosophers_trace'), 'philosophers_trace')).toBe(true)
    expect(hasTour(ANY, 'shell')).toBe(false)
  })
})

describe('defaultTourFor', () => {
  it("is the app's own file when there is one", () => {
    expect(defaultTourFor(ANY, 'basic_button', IDS)).toBe('basic_button')
  })

  it('falls back to the first other tour of an app without one', () => {
    expect(defaultTourFor(ANY, 'msg_queue', ['msg_queue.ring', 'msg_queue.basics'])).toBe('msg_queue.basics')
  })

  it('is null for an app with no tour', () => {
    expect(defaultTourFor(ANY, 'shell', IDS)).toBeNull()
  })
})

describe('tourToRun', () => {
  it('runs the default tour when the link names none', () => {
    expect(tourToRun(ANY, 'basic_button', null, IDS)).toBe('basic_button')
  })

  it("runs the tour the link names when it is this app's", () => {
    expect(tourToRun(ANY, 'basic_button', 'basic_button.msgq', IDS)).toBe('basic_button.msgq')
    expect(tourToRun(ANY, 'basic_button_trace', 'basic_button.msgq', IDS)).toBe('basic_button.msgq')
    expect(tourToRun(ANY, 'basic_button', 'basic_button', IDS)).toBe('basic_button')
  })

  it('runs no tour at all for `none`', () => {
    expect(tourToRun(ANY, 'basic_button', 'none', IDS)).toBeNull()
  })

  it("runs the default for a tour that does not exist, or is another app's", () => {
    expect(tourToRun(ANY, 'basic_button', 'basic_button.gone', IDS)).toBe('basic_button')
    expect(tourToRun(ANY, 'basic_button', 'blinky', IDS)).toBe('basic_button')
  })

  it('runs nothing on a sample with no tour, whatever the link asks', () => {
    expect(tourToRun(ANY, 'shell', 'shell', IDS)).toBeNull()
    expect(tourToRun(ANY, 'shell', 'blinky', IDS)).toBeNull()
  })
})

describe('tourNeedsTrace', () => {
  it('knows which tours point at Trace before loading them', () => {
    expect(tourNeedsTrace('philosophers')).toBe(true)
    expect(tourNeedsTrace('msgq_lab')).toBe(true)
    expect(tourNeedsTrace('blinky')).toBe(false)
    expect(tourNeedsTrace('blinky.gone')).toBe(false)
  })

  // The build-time line scan stands in for the parser; hold them to one answer.
  it("agrees with the parser's steps for every tour", async () => {
    for (const id of tourIds()) {
      const text = (await loadTourSource(id))!
      const parsed = parseTour(text).steps.some(
        (step) =>
          step.panel === 'trace' ||
          step.look.some((l) => l.kind === 'trace' || (l.kind === 'dock' && l.panel === 'trace')),
      )
      expect([id, markdownNeedsTrace(text)]).toEqual([id, parsed])
      expect([id, tourNeedsTrace(id)]).toEqual([id, parsed])
    }
  })
})

describe('tourNeedsTrace (Markdown)', () => {
  const tour = (directives: string) => `## Step\n\n\`\`\`tour\n${directives}\n\`\`\`\n\nProse.\n`

  it('reads `look:` one target, a comma list, or a list', () => {
    expect(markdownNeedsTrace(tour('at: main\nlook: trace.ipc'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\nlook: debug.cpu, trace.timeline'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\nlook:\n  - debug.cpu\n  - trace.ipc.bus_mutex'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\nlook: dock.trace'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\nlook: debug.threads'))).toBe(false)
  })

  it('reads `panel: trace` and its older spelling', () => {
    expect(markdownNeedsTrace(tour('at: main\npanel: trace'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\nreveal: trace'))).toBe(true)
    expect(markdownNeedsTrace(tour('at: main\npanel: gpio'))).toBe(false)
  })

  it('ignores the words outside ```tour blocks and under other keys', () => {
    expect(markdownNeedsTrace('Open trace.ipc yourself.\n\n```\nlook: trace.ipc\n```\n')).toBe(false)
    expect(markdownNeedsTrace(tour('at: main\nwatch:\n  - trace.ipc = $arg0'))).toBe(false)
  })
})

describe('tracedBuildOf', () => {
  it('is the twin, the sample when it traces already, or null', () => {
    const a53 = board('philosophers', 'philosophers_trace')
    expect(tracedBuildOf(a53, 'philosophers')).toBe('philosophers_trace')
    expect(tracedBuildOf(a53, 'philosophers_trace')).toBe('philosophers_trace')
    expect(tracedBuildOf(board('philosophers'), 'philosophers')).toBeNull()
    const builtin = {
      samples: [{ id: 'tracing_pipeline', primaryPanels: ['trace'] }],
    } as unknown as Board
    expect(tracedBuildOf(builtin, 'tracing_pipeline')).toBe('tracing_pipeline')
  })
})

describe('toursOn', () => {
  it('offers a tour that points at Trace only where a traced build exists', () => {
    expect(toursOn(board('philosophers', 'philosophers_trace'), 'philosophers')).toEqual(['philosophers'])
    expect(toursOn(board('philosophers'), 'philosophers')).toEqual([])
    expect(toursOn(board('blinky'), 'blinky')).toEqual(['blinky', 'blinky.code'])
  })

  it('runs no tour that points at Trace on a board without a traced build', () => {
    expect(tourToRun(board('philosophers'), 'philosophers', null)).toBeNull()
    expect(tourToRun(board('philosophers'), 'philosophers', 'philosophers')).toBeNull()
  })
})

describe('sampleForTour', () => {
  const a53 = board('philosophers', 'philosophers_trace', 'blinky', 'blinky_trace')

  it('boots the traced twin for a tour that points at Trace', () => {
    expect(sampleForTour(a53, 'philosophers', 'philosophers')).toBe('philosophers_trace')
    expect(sampleForTour(a53, 'philosophers_trace', 'philosophers')).toBe('philosophers_trace')
  })

  it('boots the sample asked for otherwise', () => {
    expect(sampleForTour(a53, 'philosophers', null)).toBe('philosophers')
    expect(sampleForTour(a53, 'blinky', 'blinky')).toBe('blinky')
  })
})

describe('loadTourSource', () => {
  it('loads a tour by its id, and nothing for an id with no file', async () => {
    expect(await loadTourSource('blinky')).toContain('sample: samples/basic/blinky')
    expect(await loadTourSource('blinky.gone')).toBeNull()
  })
})
