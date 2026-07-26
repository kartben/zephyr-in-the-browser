/**
 * Time base for DAC history samples and the Vout scope.
 *
 * Use wall time, not guest instruction count: virtio-i2c can block while
 * samples still arrive, and the scope should show real transfer cadence.
 */

export function dacNowMs(): number {
  return performance.now()
}
