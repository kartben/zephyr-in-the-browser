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
  it('splits a transfer into hop, model, wake, and guest', () => {
    // 1 kHz transfers: 1 ms each. QEMU saw 0.3 ms of browser, of which the
    // device model was 0.05 ms — so 0.25 ms is the two cross-thread hops.
    // One wake per request at 0.1 ms leaves 0.6 ms of actual guest execution.
    expect(decompose(1000, 0.3, 0.05, { avgMs: 0.1, count: 100, requests: 100 })).toEqual({
      periodMs: 1,
      roundTripAvgMs: 0.3,
      serviceAvgMs: 0.05,
      hopAvgMs: 0.25,
      wakePerTransferMs: 0.1,
      guestShareMs: 0.7,
      guestOnlyMs: 0.6,
    })
  })

  it('amortises a wake over the requests its notify covered', () => {
    // The guest batches a register read as two chains behind one notify, so
    // half as many wakes as requests. Subtracting a whole wake per request
    // would double-count it and understate the guest by the difference.
    const out = decompose(240, 0.07, 0.013, { avgMs: 0.043, count: 1205, requests: 2398 })
    expect(out.wakePerTransferMs).toBeCloseTo(0.022, 3)
    expect(out.guestOnlyMs).toBeCloseTo(4.075, 3)
  })

  it('leaves the wake fields null when 0015 is absent', () => {
    // A build without the vCPU-wake hook reports count 0. guestShareMs still
    // stands; guestOnlyMs must not silently equal it.
    const out = decompose(1000, 0.3, 0.05, { avgMs: -1, count: 0, requests: 1000 })
    expect(out.wakePerTransferMs).toBeNull()
    expect(out.guestOnlyMs).toBeNull()
    expect(out.guestShareMs).toBe(0.7)
  })

  it('reports an uninstrumented emulator as unknown, not as zero', () => {
    // -1 is what the profiler emits when the build predates 0018. Deriving a
    // 0 ms hop from it would read as "the browser is free", which is the one
    // conclusion this measurement exists to avoid reaching by accident.
    const out = decompose(1000, -1, 0.05, { avgMs: 0.1, count: 100, requests: 100 })
    expect(out.roundTripAvgMs).toBeNull()
    expect(out.hopAvgMs).toBeNull()
    expect(out.guestShareMs).toBeNull()
    expect(out.guestOnlyMs).toBeNull()
    expect(out.periodMs).toBe(1)
  })

  it('reports an idle bus as unknown rather than dividing by zero', () => {
    expect(decompose(0, -1, -1).periodMs).toBeNull()
  })
})
