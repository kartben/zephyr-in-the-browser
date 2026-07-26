/** Dock UI state: view, width, expanded/hidden/floated rows, collapsed groups. */

import type { PanelKind } from '@/boards'
import type { DeviceClass, DockView } from '@/deviceTopology'
import { clearAllPanelLayouts, migratePanelLayoutKeys } from '@/lib/panelLayout'

const STORAGE_KEY = 'zephyr.dock'
const VERSION = 1

export const DOCK_MIN_WIDTH = 17
export const DOCK_MAX_WIDTH = 28
export const DOCK_DEFAULT_WIDTH = 20

export const STAGE_DISPLAY_KEY = 'stage:display'
export const STAGE_PERF_KEY = 'stage:perf'
export const STAGE_TRACE_KEY = 'stage:trace'

export interface DockDeviceState {
  expanded?: boolean
  hidden?: boolean
  windowed?: boolean
  sections?: Record<string, boolean>
}

export interface DockSeed {
  primary: PanelKind[]
  expandAll: boolean
}

export interface DockState {
  view: DockView
  open: boolean
  width: number
  seededFor: string
  seed: DockSeed
  devices: Record<string, DockDeviceState>
  groups: Partial<Record<DeviceClass, { collapsed: boolean }>>
}

function defaults(): DockState {
  return {
    view: 'classes',
    open: true,
    width: DOCK_DEFAULT_WIDTH,
    seededFor: '',
    seed: { primary: [], expandAll: false },
    devices: {},
    groups: {},
  }
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DOCK_DEFAULT_WIDTH
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width * 2) / 2))
}

function load(): DockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults()
    const parsed = JSON.parse(raw) as { v?: number } & Partial<DockState>
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return defaults()
    const base = defaults()
    const devices =
      parsed.devices && typeof parsed.devices === 'object' ? { ...parsed.devices } : {}
    // Migrate UART row keys to controller labels.
    for (const [from, to] of [
      ['serial:console', 'uart0'],
      ['serial:uart1', 'uart1'],
    ] as const) {
      if (devices[from] !== undefined && devices[to] === undefined) {
        devices[to] = devices[from]
        delete devices[from]
      } else {
        delete devices[from]
      }
    }
    const groups =
      parsed.groups && typeof parsed.groups === 'object'
        ? ({ ...parsed.groups } as DockState['groups'])
        : {}
    if ((groups as Record<string, unknown>).serial !== undefined) {
      if (groups['uart-bus'] === undefined) {
        groups['uart-bus'] = (groups as Record<string, { collapsed: boolean }>).serial
      }
      delete (groups as Record<string, unknown>).serial
    }
    return {
      view:
        parsed.view === 'classes' || parsed.view === 'devicetree' ? parsed.view : base.view,
      open: typeof parsed.open === 'boolean' ? parsed.open : base.open,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : base.width),
      seededFor: typeof parsed.seededFor === 'string' ? parsed.seededFor : '',
      seed:
        parsed.seed && Array.isArray(parsed.seed.primary)
          ? { primary: parsed.seed.primary, expandAll: parsed.seed.expandAll === true }
          : base.seed,
      devices,
      groups,
    }
  } catch {
    return defaults()
  }
}

function save(next: DockState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...next }))
  } catch {
    /* storage full or blocked — the dock just won't survive the reload */
  }
}

migratePanelLayoutKeys()
let state: DockState = load()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function set(next: DockState) {
  state = next
  save(next)
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getState(): DockState {
  return state
}

export function effectiveExpandedIn(
  current: DockState,
  key: string,
  panelKind?: PanelKind,
): boolean {
  const override = current.devices[key]?.expanded
  if (override !== undefined) return override
  if (current.seed.expandAll) return true
  return panelKind !== undefined && current.seed.primary.includes(panelKind)
}

export function effectiveExpanded(key: string, panelKind?: PanelKind): boolean {
  return effectiveExpandedIn(state, key, panelKind)
}

export function setView(view: DockView): void {
  if (state.view !== view) set({ ...state, view })
}

export function setOpen(open: boolean): void {
  if (state.open !== open) set({ ...state, open })
}

export function setWidth(width: number): void {
  const clamped = clampWidth(width)
  if (state.width !== clamped) set({ ...state, width: clamped })
}

function patchDevice(key: string, patch: DockDeviceState): void {
  const merged: DockDeviceState = { ...state.devices[key], ...patch }
  for (const field of ['expanded', 'hidden', 'windowed'] as const) {
    if (merged[field] === undefined || (field !== 'expanded' && merged[field] === false)) {
      delete merged[field]
    }
  }
  if (merged.sections !== undefined && Object.keys(merged.sections).length === 0) {
    delete merged.sections
  }
  const devices = { ...state.devices }
  if (Object.keys(merged).length === 0) delete devices[key]
  else devices[key] = merged
  set({ ...state, devices })
}

export function setExpanded(key: string, expanded: boolean): void {
  patchDevice(key, { expanded })
}

export function setHidden(key: string, hidden: boolean): void {
  patchDevice(key, { hidden: hidden || undefined })
}

export function setWindowed(key: string, windowed: boolean): void {
  patchDevice(key, { windowed: windowed || undefined })
}

export function isHidden(key: string): boolean {
  return state.devices[key]?.hidden === true
}

export function isWindowed(key: string): boolean {
  return state.devices[key]?.windowed === true
}

export function setSection(deviceKey: string, sectionId: string, open: boolean): void {
  patchDevice(deviceKey, {
    sections: { ...state.devices[deviceKey]?.sections, [sectionId]: open },
  })
}

export function sectionOpenIn(
  current: DockState,
  deviceKey: string,
  sectionId: string,
  fallback: boolean,
): boolean {
  return current.devices[deviceKey]?.sections?.[sectionId] ?? fallback
}

export function toggleGroup(deviceClass: DeviceClass): void {
  const collapsed = !(state.groups[deviceClass]?.collapsed ?? false)
  set({ ...state, groups: { ...state.groups, [deviceClass]: { collapsed } } })
}

export function setGroupCollapsed(deviceClass: DeviceClass, collapsed: boolean): void {
  const current = state.groups[deviceClass]?.collapsed ?? false
  if (current === collapsed) return
  set({ ...state, groups: { ...state.groups, [deviceClass]: { collapsed } } })
}

export function groupCollapsed(deviceClass: DeviceClass): boolean {
  return state.groups[deviceClass]?.collapsed ?? false
}

/**
 * Same selection keeps user expansion overrides; new selection reseeds
 * expansion but preserves visibility and pop-out choices.
 */
export function seedForSelection(selection: string, seed: DockSeed): void {
  if (state.seededFor === selection) {
    const same =
      state.seed.expandAll === seed.expandAll &&
      state.seed.primary.length === seed.primary.length &&
      state.seed.primary.every((kind, i) => seed.primary[i] === kind)
    if (!same) set({ ...state, seed })
    return
  }
  const devices: Record<string, DockDeviceState> = {}
  for (const [key, value] of Object.entries(state.devices)) {
    const { expanded: _cleared, ...kept } = value
    if (Object.keys(kept).length > 0) devices[key] = kept
  }
  set({ ...state, seededFor: selection, seed, devices })
}

export function resetLayout(): void {
  clearAllPanelLayouts()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  // Keep the current selection's seed so default expansion still applies.
  const { seededFor, seed } = state
  set({ ...defaults(), seededFor, seed })
}

export function reloadFromStorage(): void {
  migratePanelLayoutKeys()
  state = load()
  notify()
}
