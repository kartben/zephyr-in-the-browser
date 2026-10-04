import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BOARDS, boardAssetDir, type Board, type GuestSample } from '@/boards'
import { buildLineIndex } from '@/debug/dwarfLines'
import { buildSymbolIndex } from '@/debug/elfSymbols'
import { archFromElf } from '@/debug/gdb/regs'
import { checkTour, count, formatReport, reportRows, type ReportRow } from '@/tours/check'
import { parseTour, type TourDoc } from '@/tours/parse'

/**
 * Every tour, resolved against the guest images the site ships. This is what
 * `npm run tour:check` runs.
 *
 * guided.test.ts parses the tours but cannot resolve one anchor: that needs the
 * ELF each tour runs against, and the images are a release asset, not part of
 * the repository. So this file is skipped when they are absent, and `npm test`
 * on a bare checkout is unchanged.
 *
 *   TOUR_IMAGES_DIR  where the images are (default public/qemu/zephyr)
 *   TOUR_STRICT=1    fail, rather than warn, when a tour's image is missing
 *                    or ships without sources or devicetree
 */

const DIR = resolve(process.cwd(), process.env.TOUR_IMAGES_DIR || 'public/qemu/zephyr')
const STRICT = process.env.TOUR_STRICT === '1'
const TOURS_DIR = resolve(process.cwd(), 'tours')

/** One image a tour runs on: a board's sample of the tour's id, or its traced twin. */
interface Job {
  tour: string
  board: Board
  sample: GuestSample
}

function tourIds(): string[] {
  return readdirSync(TOURS_DIR)
    .filter((f) => f.endsWith('.tour.md'))
    .map((f) => f.replace('.tour.md', ''))
    .sort()
}

function jobsFor(tour: string): Job[] {
  return BOARDS.flatMap((board) =>
    board.samples
      .filter((sample) => (sample.tracedFrom ?? sample.id) === tour)
      .map((sample) => ({ tour, board, sample })),
  )
}

/** The directory as a person would type it. */
function shown(dir: string): string {
  const rel = relative(process.cwd(), dir)
  return rel === '' || rel.startsWith('..') ? dir : rel
}

const docs = new Map<string, TourDoc>()
function tourDoc(tour: string): TourDoc {
  let doc = docs.get(tour)
  if (!doc) {
    doc = parseTour(readFileSync(join(TOURS_DIR, `${tour}.tour.md`), 'utf8'))
    docs.set(tour, doc)
  }
  return doc
}

/**
 * The sample's shipped sources by lowercase basename, split as the page splits
 * them, or null when the image ships none.
 */
function readSources(dir: string): Map<string, string[]> | null {
  if (!existsSync(dir)) return null
  const out = new Map<string, string[]>()
  for (const name of readdirSync(dir)) {
    out.set(name.toLowerCase(), readFileSync(join(dir, name), 'utf8').split('\n'))
  }
  return out
}

function check(job: Job): ReportRow[] {
  const dir = join(DIR, boardAssetDir(job.board))
  const image = { tour: job.tour, board: job.board.id, image: `${job.sample.id}.elf` }
  const elfPath = join(dir, image.image)
  if (!existsSync(elfPath)) {
    return [
      {
        ...image,
        step: null,
        status: `${STRICT ? 'FAIL' : 'warn'} no-image`,
        detail: `${boardAssetDir(job.board)}/${image.image} is not among the images: rebuild them to check this tour here`,
      },
    ]
  }

  const elf = new Uint8Array(readFileSync(elfPath))
  const dtsPath = join(dir, `${job.sample.id}.dts`)
  const doc = tourDoc(job.tour)
  const findings = checkTour(doc, {
    symbols: buildSymbolIndex(elf),
    lines: buildLineIndex(elf),
    arch: archFromElf(elf),
    // A traced twin reads its base sample's sources, as the page does.
    sources: readSources(join(dir, 'src', job.tour)),
    dts: existsSync(dtsPath)
      ? { name: `${job.sample.id}.dts`, lines: readFileSync(dtsPath, 'utf8').split('\n') }
      : null,
    strict: STRICT,
  })
  return reportRows(image, findings, doc.steps.length)
}

const report: ReportRow[] = []

/** Keep the rows for the table, and fail the test on any that failed. */
function record(rows: ReportRow[], doc: TourDoc | null): void {
  report.push(...rows)
  const failures = rows
    .filter((row) => row.status.startsWith('FAIL'))
    .map((row) => {
      const step = row.step === null ? undefined : doc?.steps[row.step - 1]
      const where = step ? `step ${row.step} (“${step.title}”)` : 'image'
      return `${row.tour} on ${row.board} (${row.image}), ${where}: ${row.status.slice(5)}: ${row.detail}`
    })
  expect(failures, 'the table printed after the run has every row').toEqual([])
}

describe.skipIf(!existsSync(DIR) && !STRICT)(`tours against the images in ${shown(DIR)}`, () => {
  afterAll(() => {
    if (report.length === 0) return
    const failed = report.filter((row) => row.status.startsWith('FAIL')).length
    const warned = report.filter((row) => row.status.startsWith('warn')).length
    const checked = report.filter((row) => !row.status.endsWith('no-image'))
    const images = new Set(checked.map((row) => `${row.board}/${row.image}`)).size
    const tours = new Set(report.map((row) => row.tour)).size
    const summary =
      `${count(tours, 'tour')} on ${count(images, 'image')}: ` +
      `${count(failed, 'failure')}, ${count(warned, 'warning')}`
    process.stdout.write(
      `\ntour:check against ${shown(DIR)}${STRICT ? ' (strict)' : ''}, ${summary}\n\n${formatReport(report)}\n\n`,
    )
  })

  it('finds the images', () => {
    expect(existsSync(DIR), `no images at ${DIR}: fetch them, or point TOUR_IMAGES_DIR at them`).toBe(true)
  })

  for (const tour of tourIds()) {
    const jobs = jobsFor(tour)
    if (jobs.length === 0) {
      // guided.test.ts fails on this too; here it is one more row in the table.
      it(`${tour} runs on some board`, () => {
        record(
          [
            {
              tour,
              board: '-',
              image: '-',
              step: null,
              status: `${STRICT ? 'FAIL' : 'warn'} no-image`,
              detail: `no board in src/boards.ts offers a sample with id '${tour}'`,
            },
          ],
          null,
        )
      })
      continue
    }
    for (const job of jobs) {
      it(`${tour} on ${job.board.id} (${job.sample.id}.elf)`, () => {
        const rows = check(job)
        record(rows, tourDoc(tour))
      })
    }
  }
})
