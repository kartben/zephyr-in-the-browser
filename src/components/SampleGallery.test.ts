import { describe, expect, it } from 'vitest'
import type { GuestSample } from '@/boards'
import {
  buildSampleGroups,
  groupHasTracing,
  matchesGroupQuery,
  sampleTags,
  selectSampleId,
} from '@/components/SampleGallery'

function sample(partial: Partial<GuestSample> & Pick<GuestSample, 'id' | 'label'>): GuestSample {
  return {
    description: partial.description ?? `${partial.label} description`,
    zephyrSample: partial.zephyrSample ?? `samples/${partial.id}`,
    ...partial,
  }
}

describe('buildSampleGroups', () => {
  it('pairs a base sample with its traced twin', () => {
    const base = sample({
      id: 'blinky',
      label: 'Blinky',
      primaryPanels: ['led', 'gpio'],
    })
    const traced = sample({
      id: 'blinky_trace',
      label: 'Blinky · traced',
      primaryPanels: ['led', 'gpio', 'trace', 'debug'],
      tracedFrom: 'blinky',
    })
    const groups = buildSampleGroups([base, traced], null)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.base.id).toBe('blinky')
    expect(groups[0]?.traced?.id).toBe('blinky_trace')
    expect(groups[0]?.docs.title).toBe('Blinky')
  })

  it('leaves builtin tracing samples unpaired', () => {
    const tracing = sample({
      id: 'tracing',
      label: 'Tracing',
      primaryPanels: ['trace'],
    })
    const groups = buildSampleGroups([tracing], null)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.traced).toBeNull()
    expect(sampleTags(groups[0]!)).toEqual(['trace'])
  })

  it('sorts by docs title', () => {
    const groups = buildSampleGroups(
      [
        sample({ id: 'zebra', label: 'Zebra' }),
        sample({ id: 'apple', label: 'Apple' }),
      ],
      null,
    )
    expect(groups.map((g) => g.base.id)).toEqual(['apple', 'zebra'])
  })
})

describe('sampleTags', () => {
  it('hides trace/debug panels added by the twin', () => {
    const group = buildSampleGroups(
      [
        sample({
          id: 'blinky',
          label: 'Blinky',
          primaryPanels: ['led', 'gpio'],
        }),
        sample({
          id: 'blinky_trace',
          label: 'Blinky · traced',
          primaryPanels: ['led', 'gpio', 'trace', 'debug'],
          tracedFrom: 'blinky',
        }),
      ],
      null,
    )[0]!
    expect(sampleTags(group)).toEqual(['led', 'gpio'])
  })
})

describe('tracing filter helpers', () => {
  const paired = buildSampleGroups(
    [
      sample({
        id: 'blinky',
        label: 'Blinky',
        primaryPanels: ['led'],
      }),
      sample({
        id: 'blinky_trace',
        label: 'Blinky · traced',
        tracedFrom: 'blinky',
        primaryPanels: ['led', 'trace', 'debug'],
      }),
    ],
    null,
  )[0]!

  const plain = buildSampleGroups(
    [sample({ id: 'hello', label: 'Hello', primaryPanels: undefined })],
    null,
  )[0]!

  const builtin = buildSampleGroups(
    [sample({ id: 'tracing', label: 'Tracing', primaryPanels: ['trace'] })],
    null,
  )[0]!

  it('groupHasTracing detects twins and builtin tracing', () => {
    expect(groupHasTracing(paired)).toBe(true)
    expect(groupHasTracing(builtin)).toBe(true)
    expect(groupHasTracing(plain)).toBe(false)
  })

  it('selectSampleId picks the twin only when the filter is on', () => {
    expect(selectSampleId(paired, false)).toBe('blinky')
    expect(selectSampleId(paired, true)).toBe('blinky_trace')
    expect(selectSampleId(builtin, true)).toBe('tracing')
  })
})

describe('matchesGroupQuery', () => {
  const group = buildSampleGroups(
    [
      sample({
        id: 'blinky',
        label: 'Blinky',
        description: 'Toggle an LED',
        primaryPanels: ['led'],
      }),
      sample({
        id: 'blinky_trace',
        label: 'Blinky · traced',
        tracedFrom: 'blinky',
        primaryPanels: ['led', 'trace', 'debug'],
      }),
    ],
    null,
  )[0]!

  it('matches title and tags', () => {
    expect(matchesGroupQuery(group, 'blinky')).toBe(true)
    expect(matchesGroupQuery(group, 'led')).toBe(true)
    expect(matchesGroupQuery(group, 'missing')).toBe(false)
  })

  it('matches tracing keywords against the twin', () => {
    expect(matchesGroupQuery(group, 'traced')).toBe(true)
    expect(matchesGroupQuery(group, 'ctf')).toBe(true)
  })
})
