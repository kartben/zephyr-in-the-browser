import { describe, expect, it } from 'vitest'

// @ts-expect-error — plain JS harness helper, shared with tools/profile-*.mjs
import { decompose } from '../tools/profile-decompose.mjs'

/**
 * The arithmetic that turns two measured intervals into the answer of
 * docs/performance.md item 15 — is the browser hop worth removing, or is the
 * time guest-side? Tested here because it is the conclusion-bearing part of a
 * harness that otherwise needs a rebuilt emulator to run at all.
 */
describe('profile decomposition', () => {
  it('splits a transfer into hop, model, and guest', () => {
    // 1 kHz transfers: 1 ms each. QEMU saw 0.3 ms of browser, of which the
    // device model was 0.05 ms — so 0.25 ms is the two cross-thread hops and
    // 0.7 ms never left the guest.
    expect(decompose(1000, 0.3, 0.05)).toEqual({
      periodMs: 1,
      roundTripAvgMs: 0.3,
      serviceAvgMs: 0.05,
      hopAvgMs: 0.25,
      guestShareMs: 0.7,
    })
  })

  it('reports an uninstrumented emulator as unknown, not as zero', () => {
    // -1 is what the profiler emits when the build predates 0018. Deriving a
    // 0 ms hop from it would read as "the browser is free", which is the one
    // conclusion this measurement exists to avoid reaching by accident.
    const out = decompose(1000, -1, 0.05)
    expect(out.roundTripAvgMs).toBeNull()
    expect(out.hopAvgMs).toBeNull()
    expect(out.guestShareMs).toBeNull()
    expect(out.periodMs).toBe(1)
  })

  it('reports an idle bus as unknown rather than dividing by zero', () => {
    expect(decompose(0, -1, -1).periodMs).toBeNull()
  })
})
