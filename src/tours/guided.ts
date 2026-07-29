/**
 * Which samples carry a tour, for the gallery badge.
 *
 * Derived from the files in `tours/` rather than from a list somebody has to
 * remember to update: adding a tour is dropping `tours/<sample-id>.tour.md` in,
 * and nothing else. A `_trace` twin reads its base sample's tour.
 *
 * This is only what the page can know before booting. Once a guest is running
 * the truth is whether the tour's anchors resolved against the ELF that
 * actually booted (see src/tours/store.ts).
 */

import type { GuestSample } from '@/boards'
import { hasTour } from '@/tours/catalog'

/** True when this sample explains itself as it runs. */
export function isGuided(sample: GuestSample): boolean {
  return hasTour(sample.tracedFrom ?? sample.id)
}
