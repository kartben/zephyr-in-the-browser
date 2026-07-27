/**
 * Split one blocking I²C transfer into where its time went.
 *
 * Shared by tools/profile-dac.mjs and tools/profile-accel.mjs so both harnesses
 * report the same arithmetic, and so the arithmetic itself is testable without
 * booting QEMU (src/profileDecompose.test.ts).
 *
 * Three measured inputs, each taken on the clock of the side that owns it,
 * which is the only reason this works. QEMU times request-published to
 * completion-drained and notify to vCPU-resume
 * (`0018-instrument-bridge-roundtrip.patch`, `0015-instrument-vcpu-wake-latency.patch`);
 * the page times request-picked-up to reply-published
 * (`src/virtio/transport.ts`). Nothing has to reconcile two epochs, because no
 * interval spans both.
 *
 * See docs/performance.md item 15 for what the result decides.
 */

/**
 * @param {number} i2cHz       transfers per second, measured end to end
 * @param {number} roundTripMs QEMU's browser half, or < 0 without 0018
 * @param {number} serviceMs   the page's share, or < 0 when nothing was answered
 * @param {object} [wake]      notify→vCPU-resume, or omitted/count 0 without 0015
 * @param {number} wake.avgMs  mean per *notify*, which is not per request
 * @param {number} wake.count  notifies timed
 * @param {number} wake.requests requests drained over the same window
 */
export function decompose(i2cHz, roundTripMs, serviceMs, wake) {
  const periodMs = i2cHz > 0 ? +(1000 / i2cHz).toFixed(3) : null
  // "Not measured" and "free" are the two answers this exists to tell apart,
  // so an absent counter must not produce a plausible-looking zero.
  const measured = roundTripMs >= 0 && serviceMs >= 0

  /*
   * A wake is per virtio_notify, and a notify covers a whole drain: the guest
   * I²C driver queues every message of a transfer before notifying, so a
   * two-message register read costs one wake, not two. Scaling by
   * notifies-per-request is what makes this subtractable from a per-request
   * period — the DAC's one-message writes come out 1:1, the accel chart's
   * register reads at about 1:2.
   */
  const wakeScalable =
    wake != null && wake.avgMs >= 0 && wake.count > 0 && wake.requests > 0
  const wakePerTransferMs = wakeScalable
    ? +((wake.avgMs * wake.count) / wake.requests).toFixed(3)
    : null

  return {
    periodMs,
    roundTripAvgMs: roundTripMs >= 0 ? +roundTripMs.toFixed(3) : null,
    serviceAvgMs: serviceMs >= 0 ? +serviceMs.toFixed(3) : null,
    /** The two cross-thread hops — all that moving models into wasm removes. */
    hopAvgMs: measured ? +(roundTripMs - serviceMs).toFixed(3) : null,
    /** Host rescheduling a halted vCPU, amortised over the requests it covers. */
    wakePerTransferMs,
    /** Everything not the browser: guest, TCG, and the vCPU wake. */
    guestShareMs:
      measured && periodMs != null ? +(periodMs - roundTripMs).toFixed(3) : null,
    /** Guest instructions and TCG alone, once the wake is taken out. */
    guestOnlyMs:
      measured && periodMs != null && wakePerTransferMs != null
        ? +(periodMs - roundTripMs - wakePerTransferMs).toFixed(3)
        : null,
  }
}
