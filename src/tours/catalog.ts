/**
 * Which tours exist, and how to get one.
 *
 * Tours ship **with the page**, not with the guest images. That is not an
 * implementation detail — it is the whole difference between a tour and the
 * annotation system it replaced. A tour is Markdown in this repository; the
 * image tarball is a ~100 MB containerised Zephyr build published as a release
 * asset and pinned by a repository variable. Coupling the two meant a tour
 * could not appear until somebody rebuilt Zephyr, and a deploy whose images
 * predated the feature showed nothing at all, with no way to tell that from a
 * sample that simply has no tour.
 *
 * `import.meta.glob` settles it at build time: the tours are part of the
 * bundle, so a sample that has one always has one.
 *
 * The sample's *sources* still come from the image build — they are Zephyr tree
 * files, not ours to ship — and their absence is a supported state that costs
 * the source excerpt and any `at:` pattern that needs the text to search.
 */

import type { Board } from '@/boards'
import { appOfTour, NO_TOUR } from '@/tours/tourId'

const MODULES = import.meta.glob('/tours/*.tour.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/**
 * Which tours point at Trace, worked out from each file at build time
 * (src/tours/traits.ts) so the page knows before it boots without loading
 * every tour.
 */
const NEEDS_TRACE = import.meta.glob('/tours/*.tour.md', {
  query: '?needs-trace',
  import: 'default',
  eager: true,
}) as Record<string, boolean>

function idOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace('.tour.md', '')
}

/**
 * A CTF-traced twin runs the same sources as the sample it was expanded from,
 * so it reads the same tour.
 */
export function baseSampleId(sampleId: string): string {
  return sampleId.replace(/_trace$/, '')
}

/** True when a step of this tour points at Trace, so it runs on a traced build. */
export function tourNeedsTrace(tourId: string): boolean {
  return NEEDS_TRACE[`/tours/${tourId}.tour.md`] === true
}

/**
 * The build of this sample that writes a trace on this board: the sample
 * itself when it is a traced twin or traces in its own configuration, else its
 * `_trace` twin, or null when the board has neither.
 */
export function tracedBuildOf(board: Board, sampleId: string): string | null {
  const sample = board.samples.find((s) => s.id === sampleId)
  if (sampleId.endsWith('_trace') || sample?.primaryPanels?.includes('trace')) return sampleId
  const twin = `${baseSampleId(sampleId)}_trace`
  return board.samples.some((s) => s.id === twin) ? twin : null
}

/** Every tour id, from the files themselves: `<app>` and `<app>.<slug>`. */
export function tourIds(): string[] {
  return Object.keys(MODULES).map(idOf).sort()
}

/**
 * A sample's tours: its default tour first, then the others in name order.
 * `ids` is for tests; the page passes nothing and gets the bundled tours.
 */
export function toursForApp(sampleId: string, ids: readonly string[] = tourIds()): string[] {
  const app = baseSampleId(sampleId)
  const tours = ids.filter((id) => appOfTour(id) === app)
  return [...tours.filter((id) => id === app), ...tours.filter((id) => id !== app).sort()]
}

/**
 * The tours this board can run for a sample. A tour that points at Trace
 * needs a traced build of it, and a board without one (qemu_riscv32 has no
 * `_trace` twins) does not offer that tour at all: half a tour whose Trace
 * steps show nothing is not worth starting.
 */
export function toursOn(board: Board, sampleId: string, ids?: readonly string[]): string[] {
  return toursOffered(sampleId, tracedBuildOf(board, sampleId) !== null, ids)
}

/** {@link toursOn} for a caller that knows already whether a traced build exists. */
export function toursOffered(sampleId: string, traced: boolean, ids?: readonly string[]): string[] {
  return toursForApp(sampleId, ids).filter((id) => traced || !tourNeedsTrace(id))
}

/**
 * The tour a sample runs on this board when the link names none:
 * `tours/<app>.tour.md`, or its first other tour when it has no such file.
 */
export function defaultTourFor(
  board: Board,
  sampleId: string,
  ids?: readonly string[],
): string | null {
  return toursOn(board, sampleId, ids)[0] ?? null
}

/** True when this sample has a tour on this board, from the files alone. */
export function hasTour(board: Board, sampleId: string): boolean {
  return defaultTourFor(board, sampleId) !== null
}

/**
 * The tour a boot of this sample runs, given the `?tour=` it was asked for.
 *
 * `none` runs none. One of this sample's tours runs that one. Anything else
 * (nothing asked, a tour that does not exist, another app's) runs the default
 * tour: a stale or mistyped link still lands on the sample's tour rather than
 * on a sample that says nothing.
 */
export function tourToRun(
  board: Board,
  sampleId: string,
  asked: string | null,
  ids?: readonly string[],
): string | null {
  if (asked === NO_TOUR) return null
  const tours = toursOn(board, sampleId, ids)
  if (asked !== null && tours.includes(asked)) return asked
  return tours[0] ?? null
}

/**
 * The build a tour runs on: the sample's traced build when the tour points at
 * Trace, so no Trace step lands on a guest that cannot show it. Any other tour,
 * or none, runs on the sample asked for.
 */
export function sampleForTour(board: Board, sampleId: string, tourId: string | null): string {
  if (tourId === null || !tourNeedsTrace(tourId)) return sampleId
  return tracedBuildOf(board, sampleId) ?? sampleId
}

/**
 * The app a tour's `next:` runs as on this board, or null when the board does
 * not offer it.
 *
 * A tour id names its app. A tour that points at Trace runs on the app's
 * traced build, and the board does not offer it when there is none. Any other
 * tour keeps a reader on a traced twin on one when the board has it: the tour
 * they just finished may have pointed them at Trace, and they chose the build
 * that has it.
 */
export function nextSampleId(board: Board, sampleId: string, tourId: string): string | null {
  const app = appOfTour(tourId)
  const offered = (id: string) => board.samples.some((s) => s.id === id)
  if (tourNeedsTrace(tourId)) return offered(app) ? tracedBuildOf(board, app) : null
  if (sampleId.endsWith('_trace') && offered(`${app}_trace`)) return `${app}_trace`
  return offered(app) ? app : null
}

/** A tour's Markdown, by tour id, or null when there is no such tour. */
export async function loadTourSource(tourId: string): Promise<string | null> {
  const load = MODULES[`/tours/${tourId}.tour.md`]
  if (!load) return null
  try {
    return await load()
  } catch {
    // A chunk that will not load reads the same as no tour.
    return null
  }
}
