export interface PanelBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PanelLayout {
  floating: boolean
  rect: PanelBox | null
}

const key = (id: string) => `zephyr.panel.${id}`

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

// Migrate persisted float geometry to per-bus panel keys.
const LEGACY_KEY_MIGRATIONS: Record<string, string> = {
  'sensor:48': 'virtio_i2c0:48',
  'sensor:49': 'virtio_i2c0:49',
  'sensor:53': 'virtio_i2c0:53',
  'memory:50': 'virtio_i2c0:50',
  oled: 'virtio_i2c0:3c',
  i2c: 'virtio_i2c0',
  'serial:console': 'uart0',
  'serial:uart1': 'uart1',
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

export function savePanelLayout(id: string, layout: PanelLayout): void {
  // Clear stale floating geometry once a panel is docked with no custom box.
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
