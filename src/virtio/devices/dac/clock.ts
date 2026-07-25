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
 * Throughput itself is a separate lever (~45 I²C Hz today): QEMU's completion
 * drain idles at 10 ms and, with `-icount sleep=on`, that tax lands on every
 * synchronous transfer. `VIRTIO_BROWSER_DRAIN_IDLE_MS 1` in the virtio-browser
 * patch is the fix for the next emulator rebuild; until then the scope at least
 * tracks wall time honestly.
 */

export function dacNowMs(): number {
  return performance.now()
}
