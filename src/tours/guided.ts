/**
 * Which samples carry a tour.
 *
 * Keyed by sample id, which is also the tour file's basename: `blinky` is
 * driven by `tours/blinky.tour.md`, on every board that ships it. A vitest test
 * keeps this list and the `tours/` directory in lockstep, the same way
 * samples.manifest and boards.ts are kept in step with each other.
 *
 * This is only for what the page can know before booting — the gallery badge.
 * Once a guest is running the truth is whether the tour's anchors resolved
 * against the ELF that actually booted (see src/tours/store.ts).
 */

import type { GuestSample } from '@/boards'

const TOURED_SAMPLES = new Set<string>(['blinky', 'philosophers'])

/** True when this sample explains itself as it runs. */
export function isGuided(sample: GuestSample): boolean {
  return TOURED_SAMPLES.has(sample.tracedFrom ?? sample.id)
}

/** The tour ids, for the test that checks them against `tours/`. */
export function touredSampleIds(): string[] {
  return [...TOURED_SAMPLES]
}
