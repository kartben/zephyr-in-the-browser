/**
 * Which samples carry a tour, for the gallery badge.
 *
 * Derived from the files in `tours/` rather than from a list somebody has to
 * remember to update: adding a tour is dropping `tours/<sample-id>.tour.md` in
 * (or `tours/<sample-id>.<slug>.tour.md` for another tour of the same sample),
 * and nothing else. A `_trace` twin reads its base sample's tours. A tour
 * that points at Trace is listed only when the sample has a traced build.
 *
 * This is only what the page can know before booting. Once a guest is running
 * the truth is whether the tour's anchors resolved against the ELF that
 * actually booted (see src/tours/store.ts).
 */

import type { GuestSample } from '@/boards'
import { currentLanguage } from '@/i18n'
import { toursOffered } from '@/tours/catalog'
import { loadLocalizedTour } from '@/tours/translations'

/**
 * The sample's tours by id, its default tour first: what the gallery lists.
 * `traced` says whether this board has a traced build of the sample.
 */
export function guidedTours(sample: GuestSample, traced: boolean): string[] {
  return toursOffered(sample.tracedFrom ?? sample.id, traced)
}

/** True when this sample explains itself as it runs. */
export function isGuided(sample: GuestSample, traced: boolean): boolean {
  return guidedTours(sample, traced).length > 0
}

const titles = new Map<string, Promise<string | null>>()

/**
 * A tour's title, from its front matter, in the page's language when the tour
 * has a translation there. Parsed once, and only when asked: the gallery asks
 * when it first opens, not while the page boots.
 */
export function tourTitle(id: string): Promise<string | null> {
  let title = titles.get(id)
  if (!title) {
    title = loadLocalizedTour(id, currentLanguage()).then((doc) => doc?.title ?? null)
    titles.set(id, title)
  }
  return title
}
