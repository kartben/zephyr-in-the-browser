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

/**
 * The dock re-keyed per-chip panels by bus instance (`virtio_i2c0:48`) instead
 * of role (`sensor:48`), and the Simulation readout stopped being a PanelFrame
 * altogether. Move saved float geometry to the new keys — copy, then delete —
 * so an existing user's dragged windows survive the rename. Never clobbers a
 * value already stored under a new key.
 */
const LEGACY_KEY_MIGRATIONS: Record<string, string> = {
  'sensor:48': 'virtio_i2c0:48',
  'sensor:49': 'virtio_i2c0:49',
  'sensor:53': 'virtio_i2c0:53',
  'memory:50': 'virtio_i2c0:50',
  oled: 'virtio_i2c0:3c',
  i2c: 'virtio_i2c0',
}
const LEGACY_REMOVALS = ['perf']

export function migratePanelLayoutKeys(): void {
  try {
    for (const [from, to] of Object.entries(LEGACY_KEY_MIGRATIONS)) {
      const raw = localStorage.getItem(key(from))
      if (raw === null) continue
      if (localStorage.getItem(key(to)) === null) localStorage.setItem(key(to), raw)
      localStorage.removeItem(key(from))
    }
    for (const id of LEGACY_REMOVALS) localStorage.removeItem(key(id))
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}

/** Drop every saved float box; the Panels menu's "Reset layout" calls this. */
export function clearAllPanelLayouts(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const stored = localStorage.key(i)
      if (stored?.startsWith('zephyr.panel.')) doomed.push(stored)
    }
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch {
    /* ignore */
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
