import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeRecord } from './protocol'
import {
  dismiss,
  getSnapshot,
  handleRecord,
  loadFor,
  reset,
  setEnabled,
  subscribe,
} from './store'

/** The catalog the build would have shipped for a two-step walkthrough. */
const CATALOG = {
  version: 1,
  app: 'guided',
  files: ['src/main.c'],
  annotations: [
    {
      id: 0,
      key: 'led_alias',
      title: 'The pin is named by devicetree',
      body: 'Body one.',
      panel: 'led',
      file: 0,
      line: 27,
      fireSites: [{ file: 0, line: 40 }],
    },
    {
      id: 1,
      key: 'the_toggle',
      title: 'This is the line that does the work',
      body: 'Body two.',
      file: 0,
      line: 58,
      fireSites: [{ file: 0, line: 57 }],
    },
  ],
}

/** Feed the store the same bytes the guest would put on the wire. */
function feed(payload: string) {
  const record = decodeRecord(payload)
  expect(record, `payload should decode: ${payload}`).not.toBeNull()
  handleRecord(record!)
}

/** The boot announcement for a build that linked both annotations. */
function announce(lines: [number, number][] = [[0, 27], [1, 58]]) {
  for (const [id, line] of lines) feed(`v=1;k=ann;a=${id};l=${line}`)
  feed(`v=1;k=table;n=${lines.length}`)
}

let url = 0

beforeEach(async () => {
  reset()
  setEnabled(true)
  // A fresh URL each time: the catalog cache is keyed by it, deliberately.
  const asset = `/test/${url++}.annotations.json`
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => CATALOG,
    })),
  )
  await loadFor(asset)
})

afterEach(() => {
  vi.unstubAllGlobals()
  reset()
})

describe('the boot announcement', () => {
  it('builds the outline from what the build linked in', () => {
    announce()
    const state = getSnapshot()
    expect(state.active).toBe(true)
    expect(state.outline).toEqual([0, 1])
    expect(state.drift).toBe(false)
  })

  it('reports only the annotations actually linked, not the whole catalog', () => {
    // The section is ground truth: a fire site compiled out never announces.
    announce([[0, 27]])
    expect(getSnapshot().outline).toEqual([0])
  })

  it('flags a catalog that has drifted from the binary', () => {
    // Separate artifacts, separately fetched — one really can be stale, and
    // highlighting the wrong source line is worse than saying so.
    announce([[0, 27], [1, 999]])
    expect(getSnapshot().drift).toBe(true)
  })

  it('flags a count that disagrees with the entries announced', () => {
    feed('v=1;k=ann;a=0;l=27')
    feed('v=1;k=table;n=5')
    expect(getSnapshot().drift).toBe(true)
  })
})

describe('showing an annotation', () => {
  it('positions it within the outline', () => {
    announce()
    feed('v=1;k=show;a=1')
    const current = getSnapshot().current
    expect(current?.entry.key).toBe('the_toggle')
    expect(current?.step).toBe(2)
    expect(current?.total).toBe(2)
    expect(current?.paused).toBe(false)
  })

  it('marks a pause record as paused', () => {
    announce()
    feed('v=1;k=pause;a=0')
    expect(getSnapshot().current?.paused).toBe(true)
  })

  it('records what the reader has already been shown', () => {
    announce()
    feed('v=1;k=show;a=0')
    feed('v=1;k=show;a=1')
    expect([...getSnapshot().seen]).toEqual([0, 1])
  })

  it('drops ids the catalog has never heard of', () => {
    // An annotated ELF with a stale annotations.json must not pop an empty card.
    announce()
    feed('v=1;k=show;a=99')
    expect(getSnapshot().current).toBeNull()
  })

  it('shows nothing while walkthroughs are turned off', () => {
    announce()
    setEnabled(false)
    feed('v=1;k=show;a=0')
    expect(getSnapshot().current).toBeNull()
  })
})

describe('values and lifecycle', () => {
  it('attaches a value to the annotation on screen', () => {
    announce()
    feed('v=1;k=show;a=0')
    feed('v=1;k=value;a=0;d=gpio%40e000%20pin%204')
    expect(getSnapshot().current?.value).toBe('gpio@e000 pin 4')
  })

  it('remembers a value that arrived before its annotation', () => {
    announce()
    feed('v=1;k=value;a=1;d=early')
    feed('v=1;k=show;a=1')
    expect(getSnapshot().current?.value).toBe('early')
  })

  it('clears the card on dismiss', () => {
    announce()
    feed('v=1;k=show;a=0')
    dismiss()
    expect(getSnapshot().current).toBeNull()
  })

  it('marks the walkthrough finished on end', () => {
    announce()
    feed('v=1;k=end')
    expect(getSnapshot().finished).toBe(true)
  })

  it('notifies subscribers', () => {
    const seen = vi.fn()
    const unsubscribe = subscribe(seen)
    announce()
    expect(seen).toHaveBeenCalled()
    unsubscribe()
  })
})
