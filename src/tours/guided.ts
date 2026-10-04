/**
 * Which samples carry a tour, for the gallery badge.
 *
 * Derived from the files in `tours/` rather than from a list somebody has to
 * remember to update: adding a tour is dropping `tours/<sample-id>.tour.md` in
 * (or `tours/<sample-id>.<slug>.tour.md` for another tour of the same sample),
 * and nothing else. A `_trace` twin reads its base sample's tours.
 *
 * This is only what the page can know before booting. Once a guest is running
 * the truth is whether the tour's anchors resolved against the ELF that
 * actually booted (see src/tours/store.ts).
 */

import type { GuestSample } from '@/boards'
import { hasTour, loadTourSource, toursForApp } from '@/tours/catalog'
import { parseTour } from '@/tours/parse'

/** True when this sample explains itself as it runs. */
export function isGuided(sample: GuestSample): boolean {
  return hasTour(sample.tracedFrom ?? sample.id)
}

/** The sample's tours by id, its default tour first: what the gallery lists. */
export function guidedTours(sample: GuestSample): string[] {
  return toursForApp(sample.tracedFrom ?? sample.id)
}

const titles = new Map<string, Promise<string | null>>()

/**
 * A tour's title, from its front matter. Parsed once, and only when asked:
 * the gallery asks when it first opens, not while the page boots.
 */
export function tourTitle(id: string): Promise<string | null> {
  let title = titles.get(id)
  if (!title) {
    title = loadTourSource(id).then((text) => (text === null ? null : parseTour(text).title))
    titles.set(id, title)
  }
  return title
}
