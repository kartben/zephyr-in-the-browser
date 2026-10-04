import { describe, expect, it } from 'vitest'
import type { Board } from '@/boards'
import {
  defaultTourFor,
  hasTour,
  loadTourSource,
  nextSampleId,
  toursForApp,
  tourToRun,
} from '@/tours/catalog'

/** Only the app list matters to where a `next:` lands. */
function board(...ids: string[]): Board {
  return { samples: ids.map((id) => ({ id })) } as unknown as Board
}

/** A catalog where one app has three tours. The real one has one each, so far. */
const IDS = ['basic_button', 'basic_button.msgq', 'basic_button.debounce', 'blinky', 'philosophers']

describe('nextSampleId', () => {
  it('lands on the app the tour is named after', () => {
    expect(nextSampleId(board('msg_queue', 'msgq_lab'), 'msg_queue', 'msgq_lab')).toBe('msgq_lab')
  })

  it('keeps a reader on a traced twin on the next one', () => {
    const a53 = board('msg_queue', 'msg_queue_trace', 'msgq_lab', 'msgq_lab_trace')
    expect(nextSampleId(a53, 'msg_queue_trace', 'msgq_lab')).toBe('msgq_lab_trace')
    expect(nextSampleId(a53, 'msg_queue', 'msgq_lab')).toBe('msgq_lab')
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
    expect(hasTour('philosophers_trace')).toBe(true)
    expect(hasTour('shell')).toBe(false)
  })
})

describe('defaultTourFor', () => {
  it("is the app's own file when there is one", () => {
    expect(defaultTourFor('basic_button', IDS)).toBe('basic_button')
  })

  it('falls back to the first other tour of an app without one', () => {
    expect(defaultTourFor('msg_queue', ['msg_queue.ring', 'msg_queue.basics'])).toBe('msg_queue.basics')
  })

  it('is null for an app with no tour', () => {
    expect(defaultTourFor('shell', IDS)).toBeNull()
  })
})

describe('tourToRun', () => {
  it('runs the default tour when the link names none', () => {
    expect(tourToRun('basic_button', null, IDS)).toBe('basic_button')
  })

  it("runs the tour the link names when it is this app's", () => {
    expect(tourToRun('basic_button', 'basic_button.msgq', IDS)).toBe('basic_button.msgq')
    expect(tourToRun('basic_button_trace', 'basic_button.msgq', IDS)).toBe('basic_button.msgq')
    expect(tourToRun('basic_button', 'basic_button', IDS)).toBe('basic_button')
  })

  it('runs no tour at all for `none`', () => {
    expect(tourToRun('basic_button', 'none', IDS)).toBeNull()
  })

  it("runs the default for a tour that does not exist, or is another app's", () => {
    expect(tourToRun('basic_button', 'basic_button.gone', IDS)).toBe('basic_button')
    expect(tourToRun('basic_button', 'blinky', IDS)).toBe('basic_button')
  })

  it('runs nothing on a sample with no tour, whatever the link asks', () => {
    expect(tourToRun('shell', 'shell', IDS)).toBeNull()
    expect(tourToRun('shell', 'blinky', IDS)).toBeNull()
  })
})

describe('loadTourSource', () => {
  it('loads a tour by its id, and nothing for an id with no file', async () => {
    expect(await loadTourSource('blinky')).toContain('sample: samples/basic/blinky')
    expect(await loadTourSource('blinky.gone')).toBeNull()
  })
})
