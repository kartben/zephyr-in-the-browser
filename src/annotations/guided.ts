/**
 * Which samples carry a walkthrough.
 *
 * Keyed by `GuestSample.zephyrSample` rather than by board and app id, because
 * annotations are a property of the source, not of the machine it runs on — an
 * annotated sample is annotated everywhere it builds. That also sidesteps a
 * trap: `qemu_riscv32` reuses the Cortex-A53 sample array *by reference*
 * (boards.ts), so a flag stored on the sample object could never have differed
 * between those two boards anyway.
 *
 * This is only for what the page can know before booting — the gallery badge.
 * Once a guest is running, the truth is the table it announces at startup
 * (see store.ts), which reflects what the build actually linked in.
 */

import type { GuestSample } from '@/boards'

const GUIDED_SAMPLES = new Set<string>(['zephyr-module/apps/guided_blinky'])

/** True when this sample explains itself as it runs. */
export function isGuided(sample: GuestSample): boolean {
  return GUIDED_SAMPLES.has(sample.zephyrSample)
}
