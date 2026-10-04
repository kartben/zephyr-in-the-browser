/**
 * Changing the running sample from anywhere in the page.
 *
 * The board and app live in App's state and in the query string, and a
 * committed QEMU document has to reload to change them, so only App can do it.
 * A tour's Next button sits in TourCard, which has neither. App registers the
 * path the app picker takes; anything else asks for a sample by id. The same
 * idea as src/lib/commands.ts, with a payload.
 */

export interface SampleSelection {
  /** App id on the current board. */
  sampleId: string
  /** The tour to run there, by tour id. Omitted, the app's default tour runs. */
  tourId?: string
}

type Selector = (next: SampleSelection) => void

let selector: Selector | null = null

/** Register the handler (App does, on mount). Returns an unregister. */
export function setSelector(fn: Selector): () => void {
  selector = fn
  return () => {
    if (selector === fn) selector = null
  }
}

/** Switch to another sample on the same board. False when nobody is listening. */
export function selectSample(next: SampleSelection): boolean {
  if (!selector) return false
  selector(next)
  return true
}
