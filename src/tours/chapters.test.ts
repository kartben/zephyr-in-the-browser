import { describe, expect, it } from 'vitest'
import { groupStepsByChapter } from '@/tours/chapters'
import type { TourStep } from '@/tours/parse'

function step(partial: Pick<TourStep, 'index' | 'title' | 'chapter'>): TourStep {
  return {
    body: '',
    at: null,
    file: null,
    when: null,
    stop: false,
    repeat: false,
    panel: null,
    highlight: [],
    dts: [],
    watch: [],
    memory: null,
    objects: null,
    registers: [],
    threads: false,
    ...partial,
  }
}

describe('groupStepsByChapter', () => {
  it('keeps consecutive steps with the same chapter together', () => {
    const groups = groupStepsByChapter([
      step({ index: 0, title: 'Meet', chapter: 'What you are running' }),
      step({ index: 1, title: 'CMake', chapter: 'What you are running' }),
      step({ index: 2, title: 'Submit', chapter: 'Sensing with RTIO' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.title).toBe('What you are running')
    expect(groups[0]!.steps.map((s) => s.title)).toEqual(['Meet', 'CMake'])
    expect(groups[1]!.title).toBe('Sensing with RTIO')
  })

  it('treats a missing chapter as its own group', () => {
    const groups = groupStepsByChapter([
      step({ index: 0, title: 'A', chapter: null }),
      step({ index: 1, title: 'B', chapter: null }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.title).toBeNull()
    expect(groups[0]!.steps).toHaveLength(2)
  })
})
