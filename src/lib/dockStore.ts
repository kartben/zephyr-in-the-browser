/**
 * The dock's own state: which view is showing, how wide it is, which rows are
 * expanded, hidden or popped out, which class groups are collapsed. One
 * module-level store (the hostGnss idiom), persisted to a single versioned
 * localStorage key.
 *
 * Persisting collapse/visibility used to be off the table because a hidden
 * panel had no way back (see the note in panelLayout.ts). The Panels menu is
 * that way back, so this store persists all of it — while still letting each
 * sample drive what opens by default: a per-selection *seed* supplies the
 * default expansion, and only explicit user choices are stored as overrides.
 * Changing selection clears the expansion overrides (the new sample speaks),
 * but keeps visibility and pop-out choices, which are about the user's screen
 * rather than the running program.
 */

import type { PanelKind } from '@/boards'
import type { DeviceClass, DockView } from '@/deviceTopology'
import { clearAllPanelLayouts, migratePanelLayoutKeys } from '@/lib/panelLayout'

const STORAGE_KEY = 'zephyr.dock'
const VERSION = 1

export const DOCK_MIN_WIDTH = 17
export const DOCK_MAX_WIDTH = 28
export const DOCK_DEFAULT_WIDTH = 20

/** Stage widgets the Panels menu manages alongside the dock's device rows. */
export const STAGE_DISPLAY_KEY = 'stage:display'
export const STAGE_PERF_KEY = 'stage:perf'
export const STAGE_TRACE_KEY = 'stage:trace'

export interface DockDeviceState {
  /** User override of the seeded default; absent = follow the seed. */
  expanded?: boolean
  hidden?: boolean
  /** Popped out into a floating PanelFrame window. */
  windowed?: boolean
  /** Open state of a body's internal disclosures (Network's sections). */
  sections?: Record<string, boolean>
}

export interface DockSeed {
  /** PanelKinds the running sample is about — their rows open expanded. */
  primary: PanelKind[]
  /** A user ELF with no devicetree: expand everything discoverable. */
  expandAll: boolean
}

export interface DockState {
  view: DockView
  open: boolean
  /** Dock width in rem, clamped to [DOCK_MIN_WIDTH, DOCK_MAX_WIDTH]. */
  width: number
  /** `${boardId}:${sampleId}` (or 'custom:…') the seed belongs to. */
  seededFor: string
  seed: DockSeed
  devices: Record<string, DockDeviceState>
  groups: Partial<Record<DeviceClass, { collapsed: boolean }>>
}

function defaults(): DockState {
  return {
    view: 'devicetree',
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
    return {
      view: parsed.view === 'classes' ? 'classes' : 'devicetree',
      open: typeof parsed.open === 'boolean' ? parsed.open : base.open,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : base.width),
      seededFor: typeof parsed.seededFor === 'string' ? parsed.seededFor : '',
      seed:
        parsed.seed && Array.isArray(parsed.seed.primary)
          ? { primary: parsed.seed.primary, expandAll: parsed.seed.expandAll === true }
          : base.seed,
      devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
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

/** Immutable snapshot; a new object on every change (useSyncExternalStore). */
export function getState(): DockState {
  return state
}

/**
 * The seeded default a row falls back to when the user has not touched it.
 * Pure over an explicit state, so the seeding rules are unit-testable.
 */
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
  // Drop keys that carry no information, so the record stays small.
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

/** Persist one of a body's internal disclosures (Network's sections). */
export function setSection(deviceKey: string, sectionId: string, open: boolean): void {
  patchDevice(deviceKey, {
    sections: { ...state.devices[deviceKey]?.sections, [sectionId]: open },
  })
}

/** Pure read with a per-section default, mirroring effectiveExpandedIn. */
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

/** Force a class group's collapsed state (revealDockRow expands without toggle). */
export function setGroupCollapsed(deviceClass: DeviceClass, collapsed: boolean): void {
  const current = state.groups[deviceClass]?.collapsed ?? false
  if (current === collapsed) return
  set({ ...state, groups: { ...state.groups, [deviceClass]: { collapsed } } })
}

export function groupCollapsed(deviceClass: DeviceClass): boolean {
  return state.groups[deviceClass]?.collapsed ?? false
}

/**
 * Install the expansion defaults for the current board/sample selection.
 * Same selection (a reload): user overrides stay. New selection: expansion
 * overrides are cleared so the new sample's defaults speak; visibility and
 * pop-out choices persist — they are about the user's screen, not the guest.
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

/** The Panels menu's "Reset layout": dock state and every saved float box. */
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

/** Re-run migration + load. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  migratePanelLayoutKeys()
  state = load()
  notify()
}
