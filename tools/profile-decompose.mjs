/**
 * Split one blocking I²C transfer into where its time went.
 *
 * Shared by tools/profile-dac.mjs and tools/profile-accel.mjs so both harnesses
 * report the same arithmetic, and so the arithmetic itself is testable without
 * booting QEMU (src/profileDecompose.test.ts).
 *
 * The two measured inputs come from opposite sides and each is taken on its own
 * clock, which is the only reason this works: QEMU times request-published to
 * completion-drained (`0018-instrument-bridge-roundtrip.patch`), the page times
 * request-picked-up to reply-published (`src/virtio/transport.ts`). Nothing has
 * to reconcile the two epochs, because neither interval spans both.
 *
 * See docs/performance.md item 15 for what the result decides.
 */

/**
 * @param {number} i2cHz      transfers per second, measured end to end
 * @param {number} roundTripMs QEMU's half, or < 0 when the build lacks 0018
 * @param {number} serviceMs   the page's half, or < 0 when nothing was answered
 */
export function decompose(i2cHz, roundTripMs, serviceMs) {
  const periodMs = i2cHz > 0 ? +(1000 / i2cHz).toFixed(3) : null
  // "Not measured" and "free" are the two answers this exists to tell apart,
  // so an absent counter must not produce a plausible-looking zero.
  const measured = roundTripMs >= 0 && serviceMs >= 0
  return {
    periodMs,
    roundTripAvgMs: roundTripMs >= 0 ? +roundTripMs.toFixed(3) : null,
    serviceAvgMs: serviceMs >= 0 ? +serviceMs.toFixed(3) : null,
    /** The two cross-thread hops — all that moving models into wasm removes. */
    hopAvgMs: measured ? +(roundTripMs - serviceMs).toFixed(3) : null,
    /** What is left for the guest driver, the ISR, and TCG. */
    guestShareMs:
      measured && periodMs != null ? +(periodMs - roundTripMs).toFixed(3) : null,
  }
}
