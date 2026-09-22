/**
 * The GPIO worker/page contract, in its own module so both ends can import it
 * without either pulling in the other's environment.
 */

/**
 * Retained output words, oldest first, plus the state that only matters at the
 * end of the batch.
 *
 * `edges` is the part that cannot be reduced to a snapshot: the seven-segment
 * latch (`src/hostSevenSeg.ts`) and the SCT2024's LA pin both respond to the
 * sequence, not the final value. Everything else in here is last-value-wins.
 */
export interface GpioBatch {
  /** Every distinct output word since the last batch, in order. */
  edges: Uint32Array
  /**
   * Edges lost to ring overflow. Non-zero means the latch downstream cannot be
   * trusted for this batch and should resynchronise from `outputs` rather than
   * replay, because a missing multiplex frame is a wrong digit, not a late one.
   */
  dropped: number
  inputs: number
  outputs: number
  ngpio: number
  /** Per line: 0 none, 1 out, 2 in. Matches the virtio-gpio encoding. */
  directions: Uint8Array
}

export type GpioInputRequest = { type: 'inputs'; mask: number }

/**
 * Roughly twenty frames of a 1 ms multiplex refresh. gpio-7-segment writes the
 * segment bus and then a digit common, so an edge count of a few per millisecond
 * is normal and a frame holds a couple of hundred.
 */
export const GPIO_EDGE_CAPACITY = 4096
