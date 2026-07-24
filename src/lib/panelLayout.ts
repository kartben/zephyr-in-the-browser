/**
 * Per-panel layout persisted across reloads, so an undocked, dragged, or
 * resized panel comes back where the user left it. Keyed by the panel's
 * PanelKind (see src/boards.ts).
 *
 * Two things are deliberately NOT stored: dismissal (a hidden panel with no
 * restore UI would vanish for good) and collapse (the running sample drives
 * which panels open expanded — see App.tsx — and a saved value would override
 * that per-sample default). Both stay session-only concerns of PanelFrame.
 */

/** A floating panel's viewport-relative box, in CSS pixels. */
export interface PanelBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PanelLayout {
  /** Popped out of the bottom-right stack into a free-floating card. */
  floating: boolean
  /** Where/how big the floating card is; null until first undock. */
  rect: PanelBox | null
}

const key = (id: string) => `zephyr.panel.${id}`

/**
 * Read a panel's saved layout. Returns a partial so callers keep their own
 * defaults for anything absent, and null when nothing is stored or storage is
 * unavailable (private mode, disabled cookies).
 */
export function loadPanelLayout(id: string): Partial<PanelLayout> | null {
  try {
    const raw = localStorage.getItem(key(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PanelLayout>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Persist a panel's layout, silently tolerating quota or private-mode errors. */
export function savePanelLayout(id: string, layout: PanelLayout): void {
  // Nothing worth storing once a panel is docked with no custom box — clear the
  // key so a stale floating position can't resurrect on the next reload.
  if (!layout.floating && !layout.rect) {
    try {
      localStorage.removeItem(key(id))
    } catch {
      /* ignore */
    }
    return
  }
  try {
    localStorage.setItem(key(id), JSON.stringify(layout))
  } catch {
    /* storage full or blocked — layout just won't survive the reload */
  }
}
