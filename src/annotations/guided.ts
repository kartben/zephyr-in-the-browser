import type { GuestSample } from '@/boards'

// Keyed by source path; qemu_riscv32 shares sample objects with Cortex-A53.
const GUIDED_SAMPLES = new Set<string>(['zephyr-module/apps/guided_blinky'])

export function isGuided(sample: GuestSample): boolean {
  return GUIDED_SAMPLES.has(sample.zephyrSample)
}
