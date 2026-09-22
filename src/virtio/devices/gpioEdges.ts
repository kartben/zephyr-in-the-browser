/**
 * Retained GPIO output words, on the device-execution side.
 *
 * The consumers on the presentation thread do not sample the output word, they
 * fold over it: `src/hostSevenSeg.ts` latches a segment pattern each time a
 * digit common goes active, reconstructing a display that is only ever lit one
 * digit at a time, and the SCT2024 latches its shift register on a pin edge.
 * Handing those a snapshot once a frame would show the wrong digits, so the
 * sequence is kept here and replayed there.
 *
 * Split out of `deviceWorker.ts` so it can be tested: that module reads `self`
 * at import time and cannot be loaded outside a worker.
 */

export interface GpioEdgeBatch {
  /** Distinct output words since the last take, oldest first. */
  edges: Uint32Array
  /**
   * Edges lost to overflow. The caller must treat a non-zero count as "do not
   * replay": a missing multiplex frame latches a *wrong* digit rather than a
   * late one, so resynchronising from the current word is the honest answer.
   */
  dropped: number
}

export interface GpioEdgeRecorder {
  /** Record an output word. Repeats of the last word are not edges. */
  record(outputs: number): void
  /** Whether anything is waiting to be sent. */
  readonly pending: boolean
  /** Hand over what has accumulated and start a fresh batch. */
  take(): GpioEdgeBatch
  reset(): void
}

export function createGpioEdgeRecorder(capacity: number): GpioEdgeRecorder {
  const buffer = new Uint32Array(capacity)
  let count = 0
  let dropped = 0
  let last = 0
  let seeded = false

  return {
    record(outputs) {
      // >>> 0 so a word with bit 31 set compares equal across the boundary:
      // the model builds it with `1 << line`, which is signed.
      const word = outputs >>> 0
      if (seeded && word === last) return
      seeded = true
      last = word
      if (count < buffer.length) buffer[count++] = word
      else dropped++
    },

    get pending() {
      return count > 0 || dropped > 0
    },

    take() {
      const batch: GpioEdgeBatch = { edges: buffer.slice(0, count), dropped }
      count = 0
      dropped = 0
      return batch
    },

    reset() {
      count = 0
      dropped = 0
      seeded = false
      last = 0
    },
  }
}
