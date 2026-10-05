/**
 * Where the tour card sits, once the reader has moved it. Null means its home:
 * centered over the top of the terminal. One module-level store rather than
 * component state, because each kind of card (a step, the wait for the reader,
 * the end of the tour) mounts its own frame, and the card must stay where it
 * was put as the tour goes from one to the next.
 *
 * Persisted under the `zephyr.panel.` prefix, so the Panels menu's "Reset
 * layout" (clearAllPanelLayouts) forgets it along with every other window.
 */

import type { PanelBox } from '@/lib/panelLayout'

export interface TourLayout extends PanelBox {
  /**
   * The reader has pulled the top or bottom edge, so `h` is the card's height.
   * Until then the card sizes to each step's content and `h` only follows it.
   */
  sized: boolean
}

const STORAGE_KEY = 'zephyr.panel.tour-card'

function load(): TourLayout | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TourLayout>
    const { x, y, w, h } = parsed
    if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    return { x: x!, y: y!, w: w!, h: h!, sized: parsed.sized === true }
  } catch {
    return null
  }
}

function save(next: TourLayout | null): void {
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage full or blocked: the card just goes home on the next reload */
  }
}

let layout: TourLayout | null = load()
const listeners = new Set<() => void>()
let pendingSave: ReturnType<typeof setTimeout> | null = null

export function getTourLayout(): TourLayout | null {
  return layout
}

export function subscribeTourLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Move, resize or (with null) send the card home. A drag calls this on every
 * pointermove, so the localStorage write is debounced, as PanelFrame's is.
 */
export function setTourLayout(next: TourLayout | null): void {
  layout = next
  listeners.forEach((listener) => listener())
  if (pendingSave) clearTimeout(pendingSave)
  pendingSave = setTimeout(() => {
    pendingSave = null
    save(layout)
  }, 150)
}
