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
 * The tour a sample runs when the link names none: `tours/<app>.tour.md`, or
 * its first other tour when it has no such file.
 */
export function defaultTourFor(sampleId: string, ids?: readonly string[]): string | null {
  return toursForApp(sampleId, ids)[0] ?? null
}

/** True when this sample has any tour, from the files alone: no list to keep in step. */
export function hasTour(sampleId: string): boolean {
  return defaultTourFor(sampleId) !== null
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
  sampleId: string,
  asked: string | null,
  ids?: readonly string[],
): string | null {
  if (asked === NO_TOUR) return null
  const tours = toursForApp(sampleId, ids)
  if (asked !== null && tours.includes(asked)) return asked
  return tours[0] ?? null
}

/**
 * The app a tour's `next:` runs as on this board, or null when the board does
 * not offer it.
 *
 * A tour id names its app. A reader on a traced twin stays on one when the
 * board has it: the tour they just finished may have pointed them at Trace,
 * and they chose the build that has it.
 */
export function nextSampleId(board: Board, sampleId: string, tourId: string): string | null {
  const app = appOfTour(tourId)
  const offered = (id: string) => board.samples.some((s) => s.id === id)
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
