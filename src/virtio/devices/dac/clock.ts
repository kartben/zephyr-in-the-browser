/**
 * Time base for DAC history samples and the Vout scope.
 *
 * Wall clock on purpose. Guest icount (`guestVirtualNowMs`) looked attractive
 * so `k_sleep(K_MSEC(1)) × 4096` would read as a ~4 s period under `-icount`,
 * but `qemu_browser_guest_icount` exports `icount_get_raw()` — instruction
 * count, not the warped virtual clock. Measured on `dac` @ A53 while the guest
 * is blocked on virtio-i2c: ~2 ms of that counter per wall second, so the
 * scope's "now" froze while codes still updated and the trace looked stuck.
 *
 * Throughput itself is a separate lever. The original 10 ms completion drain
 * managed ~45 I²C Hz; the deployed timer-driven bridge later reached ~236 Hz.
 * A local rebuild with atomic request wakes and completion kicks measured
 * ~748 Hz. The scope uses wall time so each of those regimes is rendered
 * honestly rather than making a slow transfer stream look like a 4 s period.
 */

export function dacNowMs(): number {
  return performance.now()
}
