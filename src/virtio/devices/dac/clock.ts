/**
 * Time base for DAC history samples and the Vout scope.
 *
 * Prefer guest virtual time when `-icount` is live so `k_sleep(K_MSEC(1))`
 * steps land 1 ms apart on the chart (stock sawtooth ≈ 4 s). Fall back to
 * wall clock when icount is unavailable (riscv32 TCI, unit tests).
 */

import { guestVirtualNowMs } from '@/guestStats'

export function dacNowMs(): number {
  return guestVirtualNowMs() ?? performance.now()
}
