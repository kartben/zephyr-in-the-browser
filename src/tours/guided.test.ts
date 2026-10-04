import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARDS, type GuestSample } from '@/boards'
import { isKnownFormat } from '@/tours/expr'
import { patternFile } from '@/tours/anchors'
import { parseTour } from '@/tours/parse'
import { tourIds } from '@/tours/catalog'
import { appOfTour, isTourId } from '@/tours/tourId'

/**
 * The tours in `tours/` are shipped content, and a broken one fails quietly at
 * runtime — a step whose anchor is malformed just never appears. So they are
 * parsed here, where a mistake is a failing test instead of a lesson nobody
 * notices is missing.
 *
 * Anchors cannot be *resolved* without a built ELF, which this test does not
 * have. What it can check is everything up to that: the file parses, the page
 * bundle can see it, and the sample each tour claims to be about is the one the
 * gallery will run it against. Resolving them against the images the site
 * ships is images.test.ts (`npm run tour:check`), which needs those images.
 */

const TOURS_DIR = resolve(process.cwd(), 'tours')

/** The Zephyr tree `sources:` paths are relative to, when this machine has one. */
const ZEPHYR_TREE = join(process.env.ZEPHYR_WS ?? join(homedir(), 'zephyrproject'), 'zephyr')

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
    // Sorted as ids: `blinky.second.tour.md` sorts before `blinky.tour.md` as
    // a file name, but `blinky` comes before `blinky.second` as a tour id.
    expect(tourIds()).toEqual(tourFiles().map((f) => f.replace('.tour.md', '')).sort())
  })

  it.each(tourFiles())('%s parses with no authoring errors', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    expect(doc.problems).toEqual([])
    expect(doc.steps.length).toBeGreaterThan(0)
    expect(doc.title).not.toBe('Guided tour') // i.e. the front matter named one
  })

  it.each(tourFiles())('%s is about a sample the gallery offers', (file) => {
    // `<app>.tour.md` is the app's default tour, `<app>.<slug>.tour.md`
    // another one: the app is in the name, and it has to be a real one.
    const id = file.replace('.tour.md', '')
    expect(isTourId(id), `${file} is not named <app>.tour.md or <app>.<slug>.tour.md`).toBe(true)
    const app = appOfTour(id)
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    const sample = sampleById(app)
    expect(sample, `no sample with id '${app}' in boards.ts`).toBeDefined()
    expect(doc.sample).toBe(sample!.zephyrSample)
  })

  it.each(tourFiles())("%s sits beside its app's default tour", (file) => {
    // The image build ships the sources a tour's excerpts show for apps with
    // a `<app>.tour.md`, so another tour of the app needs that one too.
    const app = appOfTour(file.replace('.tour.md', ''))
    expect(tourFiles(), `${file} needs a tours/${app}.tour.md`).toContain(`${app}.tour.md`)
  })

  it.each(tourFiles())('%s ends somewhere real', (file) => {
    const id = file.replace('.tour.md', '')
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    if (doc.outro) expect(doc.outro.body, 'the outro has no prose').not.toBe('')
    if (doc.next === null) return
    // A Next button that goes nowhere is the same silent failure as a broken
    // anchor, only at the end of the tour instead of the middle.
    expect(tourIds(), `next: ${doc.next} is not a tour`).toContain(doc.next)
    expect(doc.next, 'a tour cannot chain to itself').not.toBe(id)
    // Next stays on the reader's board, so some board has to offer both apps.
    const [from, to] = [appOfTour(id), appOfTour(doc.next)]
    const both = BOARDS.some(
      (board) => board.samples.some((s) => s.id === from) && board.samples.some((s) => s.id === to),
    )
    expect(both, `no board offers both ${from} and ${to}`).toBe(true)
  })

  it.each(tourFiles())('%s has usable stage directions on every step', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    for (const step of doc.steps) {
      expect(step.at, `step ${step.index + 1} has no anchor`).toBeTruthy()
      // A pattern anchor needs the sample's sources, which arrive with the
      // guest images and can be older than the tour. Every one carries a
      // fallback so the step still resolves on a build without them.
      if (patternFile(step.at) !== null) {
        expect(
          step.at.includes('|'),
          `step ${step.index + 1}: a pattern anchor wants a \`|\` fallback`,
        ).toBe(true)
      }
      expect(step.body.trim(), `step ${step.index + 1} has no prose`).not.toBe('')
      for (const watch of step.watch) {
        expect(isKnownFormat(watch.format)).toBe(true)
      }
      // A step that retries holds the tour until it passes, so it has to say
      // what to try when it does not.
      if (step.retry) {
        expect(step.fail, `step ${step.index + 1}: \`retry: yes\` wants a \`fail:\``).not.toBeNull()
      }
      // A `when:` item that is neither a hit condition nor a state predicate
      // is a parse problem, which the authoring-errors test fails on.
      const conditioned = step.when.hits.length > 0 || step.when.state.length > 0
      // A step that neither stops nor repeats fires once and is gone before
      // the reader can act on it — almost always a typo for `stop: no`.
      expect(step.stop || step.repeat || conditioned).toBe(true)
    }
  })

  it.each(tourFiles())('%s lists only sources that exist', (file) => {
    const doc = parseTour(readFileSync(resolve(TOURS_DIR, file), 'utf8'))
    // The parser has already refused absolute and `..` paths. A path that
    // names no file ships nothing, and its stops show no code. This repo's
    // own files can always be checked; Zephyr's only where a tree is at hand.
    for (const source of doc.sources) {
      const own = source.startsWith('zephyr-module/')
      if (!own && !existsSync(ZEPHYR_TREE)) continue
      const path = own ? resolve(process.cwd(), source) : join(ZEPHYR_TREE, source)
      expect(existsSync(path), `\`sources: ${source}\` is not at ${path}`).toBe(true)
    }
  })
})
