import { describe, expect, it } from 'vitest'
import { BOARDS, getBoard } from '@/boards'
import {
  LEARN_BOARD,
  TRACKS,
  findStep,
  isUnlocked,
  nextStep,
  progressLabel,
  seriesProgress,
  stepAfter,
  stepMatchesSelection,
  suggestNextTrack,
  trackProgress,
  type LearnTrack,
} from './tracks'

const allSteps = TRACKS.flatMap((track) => track.steps)

describe('catalog integrity', () => {
  it('is the fifteen-step envnode series in four tracks', () => {
    expect(TRACKS).toHaveLength(4)
    expect(allSteps).toHaveLength(15)
    // Strictly linear: display numbers count 01..15 across the tracks.
    expect(allSteps.map((s) => s.num)).toEqual(
      Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0')),
    )
  })

  it('has unique track and step ids', () => {
    const trackIds = TRACKS.map((t) => t.id)
    expect(new Set(trackIds).size).toBe(trackIds.length)
    const stepIds = allSteps.map((s) => s.id)
    expect(new Set(stepIds).size).toBe(stepIds.length)
  })

  it('runs on a board that exists', () => {
    expect(BOARDS.some((b) => b.id === LEARN_BOARD)).toBe(true)
  })

  it('only references samples that exist on the Learn board', () => {
    // Strict on purpose: getSample() silently falls back to the board's first
    // sample, so a typo here would boot the wrong app instead of failing.
    const board = getBoard(LEARN_BOARD)
    for (const step of allSteps) {
      if (step.sampleId === undefined) continue
      expect(
        board.samples.some((sample) => sample.id === step.sampleId),
        `${step.id} names sample '${step.sampleId}'`,
      ).toBe(true)
    }
  })

  it('gives every step a takeaway and a try-it, ready for unlock', () => {
    for (const step of allSteps) {
      expect(step.takeaway.length, step.id).toBeGreaterThan(0)
      expect(step.tryThis?.length ?? 0, step.id).toBeGreaterThan(0)
      expect(step.dockPanels, step.id).toBeDefined()
    }
  })
})

function track(id: string): LearnTrack {
  const found = TRACKS.find((t) => t.id === id)
  if (!found) throw new Error(`no track '${id}'`)
  return found
}

/** A copy of the first track with its first two steps unlocked, for helpers. */
function unlockedTrack(): LearnTrack {
  const base = track('kernel-foundations')
  return {
    ...base,
    steps: base.steps.map((step, i) =>
      i < 2 ? { ...step, sampleId: 'hello_world' } : step,
    ),
  }
}

describe('progress helpers', () => {
  it('trackProgress counts done, total and unlocked', () => {
    const t = unlockedTrack()
    expect(trackProgress(t, new Set())).toEqual({ done: 0, total: 5, unlocked: 2 })
    expect(trackProgress(t, new Set(['01-hello']))).toEqual({
      done: 1,
      total: 5,
      unlocked: 2,
    })
    // Ids from other tracks do not leak in.
    expect(trackProgress(t, new Set(['15-observability'])).done).toBe(0)
  })

  it('progressLabel reads still-being-written / not started / N of M / all done', () => {
    expect(progressLabel({ done: 0, total: 5, unlocked: 0 })).toBe('still being written')
    expect(progressLabel({ done: 0, total: 5, unlocked: 2 })).toBe('not started')
    expect(progressLabel({ done: 3, total: 7, unlocked: 7 })).toBe('3 of 7 done')
    expect(progressLabel({ done: 5, total: 5, unlocked: 5 })).toBe('all 5 done')
  })

  it('nextStep is the first unlocked step not yet done', () => {
    const t = unlockedTrack()
    expect(nextStep(t, new Set())?.id).toBe('01-hello')
    expect(nextStep(t, new Set(['01-hello']))?.id).toBe('02-threads')
    // Everything unlocked is done; the locked tail is not a next step.
    expect(nextStep(t, new Set(['01-hello', '02-threads']))).toBeNull()
    // Fully locked track has nothing to resume.
    expect(nextStep(track('doing-it-properly'), new Set())).toBeNull()
  })

  it('suggestNextTrack prefers the track underway, then the first startable', () => {
    // Today every step is locked, so there is nothing to suggest.
    expect(suggestNextTrack(TRACKS, new Set())).toBeNull()

    const t1 = unlockedTrack()
    const others = TRACKS.filter((t) => t.id !== t1.id)
    expect(suggestNextTrack([t1, ...others], new Set())?.id).toBe(t1.id)
    // In progress beats untouched, wherever it sits in the order.
    const t3 = {
      ...track('turning-it-into-a-product'),
      steps: track('turning-it-into-a-product').steps.map((s) => ({
        ...s,
        sampleId: 'hello_world',
      })),
    }
    expect(
      suggestNextTrack([t1, t3], new Set(['10-settings']))?.id,
    ).toBe(t3.id)
    // Everything done: nothing to suggest.
    expect(
      suggestNextTrack([t1], new Set(t1.steps.map((s) => s.id)))?.id,
    ).toBeUndefined()
  })

  it('seriesProgress spans all tracks', () => {
    expect(seriesProgress(new Set())).toEqual({ done: 0, total: 15 })
    expect(seriesProgress(new Set(['01-hello', '07-gpio', 'not-a-step'])).done).toBe(2)
  })
})

describe('lookup helpers', () => {
  it('findStep and stepAfter walk the catalog', () => {
    expect(findStep('08-sensor')?.track.id).toBe('describing-the-hardware')
    expect(findStep('nope')).toBeNull()
    expect(stepAfter('01-hello')?.id).toBe('02-threads')
    // Track boundaries are boundaries: 05 is the end of its track.
    expect(stepAfter('05-timers')).toBeNull()
    expect(stepAfter('15-observability')).toBeNull()
  })

  it('stepMatchesSelection needs the Learn board, the sample, and an unlock', () => {
    const locked = findStep('07-gpio')!.step
    expect(isUnlocked(locked)).toBe(false)
    expect(stepMatchesSelection(locked, LEARN_BOARD, 'blinky')).toBe(false)

    const unlocked = { ...locked, sampleId: 'blinky' }
    expect(stepMatchesSelection(unlocked, LEARN_BOARD, 'blinky')).toBe(true)
    expect(stepMatchesSelection(unlocked, LEARN_BOARD, 'shell')).toBe(false)
    expect(stepMatchesSelection(unlocked, 'qemu_riscv32', 'blinky')).toBe(false)
  })
})
