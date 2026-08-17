import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARDS, type GuestSample } from '@/boards'
import { isKnownFormat } from '@/tours/expr'
import { patternFile } from '@/tours/anchors'
import { parseTour } from '@/tours/parse'
import { tourIds } from '@/tours/catalog'
import { whenFires } from '@/tours/when'

/**
 * The tours in `tours/` are shipped content, and a broken one fails quietly at
 * runtime — a step whose anchor is malformed just never appears. So they are
 * parsed here, where a mistake is a failing test instead of a lesson nobody
 * notices is missing.
 *
 * Anchors cannot be *resolved* without a built ELF, which this test does not
 * have. What it can check is everything up to that: the file parses, the page
 * bundle can see it, and the sample each tour claims to be about is the one the
 * gallery will run it against.
 */

const TOURS_DIR = resolve(process.cwd(), 'tours')

function tourFiles(): string[] {
  return readdirSync(TOURS_DIR)
    .filter((f) => f.endsWith('.tour.md'))
    .sort()
}

function sampleById(id: string): GuestSample | undefined {
  for (const board of BOARDS) {
    const found = board.samples.find((s) => s.id === id)
    if (found) return found
  }
  return undefined
}

describe('tours/', () => {
  it('is discovered from the files themselves', () => {
    // No hand-kept list to drift: dropping a file in `tours/` is the whole
    // wiring, and this is what proves the glob sees it.
    expect(tourIds()).toEqual(tourFiles().map((f) => f.replace('.tour.md', '')))
  })

  it.each(tourFiles())('%s parses with no authoring errors', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    expect(doc.problems).toEqual([])
    expect(doc.steps.length).toBeGreaterThan(0)
    expect(doc.title).not.toBe('Guided tour') // i.e. the front matter named one
  })

  it.each(tourFiles())('%s is about a sample the gallery offers', (file) => {
    const id = file.replace('.tour.md', '')
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    const sample = sampleById(id)
    expect(sample, `no sample with id '${id}' in boards.ts`).toBeDefined()
    expect(doc.sample).toBe(sample!.zephyrSample)
  })

  it.each(tourFiles())('%s has usable stage directions on every step', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    for (const step of doc.steps) {
      expect(
        step.at || step.file || step.dts.length > 0,
        `step ${step.index + 1} has no at/file/dts`,
      ).toBeTruthy()
      // A pattern anchor needs the sample's sources, which arrive with the
      // guest images and can be older than the tour. Every one carries a
      // fallback so the step still resolves on a build without them.
      if (step.at && patternFile(step.at) !== null) {
        expect(
          step.at.includes('|'),
          `step ${step.index + 1}: a pattern anchor wants a \`|\` fallback`,
        ).toBe(true)
      }
      expect(step.body.trim(), `step ${step.index + 1} has no prose`).not.toBe('')
      for (const watch of step.watch) {
        expect(isKnownFormat(watch.format)).toBe(true)
      }
      if (step.when !== null) {
        expect(whenFires(step.when, 1).invalid, `step ${step.index + 1}: bad \`when\``).toBe(false)
      }
      // A step that neither stops nor repeats fires once and is gone before
      // the reader can act on it — almost always a typo for `stop: no`.
      expect(step.stop || step.repeat || step.when !== null).toBe(true)
    }
  })
})
