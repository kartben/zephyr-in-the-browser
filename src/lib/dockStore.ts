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
 * but keeps visibility, pop-out, section, and tab choices, which are about the
 * user's screen rather than the running program.
 */

import type { PanelKind } from '@/boards'
import type { DeviceClass, DockView } from '@/deviceTopology'
import { clearAllPanelLayouts, migratePanelLayoutKeys } from '@/lib/panelLayout'

const STORAGE_KEY = 'zephyr.dock'
const VERSION = 1

export const DOCK_MIN_WIDTH = 17
/**
 * The dock now hosts the guest's framebuffer and the CTF timeline, which are
 * about area in a way a sensor card never was — so it drags a lot wider than
 * the 28rem that fitted a column of little cards.
 */
export const DOCK_MAX_WIDTH = 48
export const DOCK_DEFAULT_WIDTH = 21

/**
 * The machine's own instruments — not devicetree nodes, so they have no
 * inventory key of their own. The `stage:` prefix is historical (they used to
 * float over the terminal); it is kept so existing layouts survive.
 */
export const STAGE_PERF_KEY = 'stage:perf'
export const STAGE_TRACE_KEY = 'stage:trace'
export const STAGE_DEBUG_KEY = 'stage:debug'

export interface DockDeviceState {
  /** User override of the seeded default; absent = follow the seed. */
  expanded?: boolean
  hidden?: boolean
  /** Popped out into a floating PanelFrame window. */
  windowed?: boolean
  /** Open state of a body's internal disclosures (Network's sections). */
  sections?: Record<string, boolean>
  /**
   * Selected body tab (Debug inspect tabs, Trace Timeline/Queues/Net).
   * User screen preference — survives sample switches like hidden/windowed.
   */
  tab?: string
}

export interface DockSeed {
  /** PanelKinds the running sample is about — their rows open expanded. */
  primary: PanelKind[]
  /** A user ELF with no devicetree: expand everything discoverable. */
  expandAll: boolean
  /**
   * A Learn step's dock preset: rows whose kind is not listed default to
   * hidden, so an early tutorial is not buried under twenty peripherals.
   * User overrides win, the Panels menu stays the way back. Absent = the
   * ordinary dock.
   */
  only?: PanelKind[]
}

export interface DockState {
  view: DockView
  /** Desktop sidebar preference — persisted. */
  open: boolean
  /**
   * Narrow-viewport drawer visibility. A different thing from `open`: the
   * drawer covers the terminal, so it starts closed on every visit like any
   * other mobile drawer, and is deliberately never persisted.
   */
  drawerOpen: boolean
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
    view: 'classes',
    open: true,
    drawerOpen: false,
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
    // UART rows used to be keyed serial:console / serial:uart1; rename to the
    // controller labels I²C/SPI buses already use. The display was a stage
    // widget before it became an ordinary device row keyed by its DT node.
    for (const [from, to] of [
      ['serial:console', 'uart0'],
      ['serial:uart1', 'uart1'],
      ['stage:display', 'display'],
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
      // Never restored: a drawer that reopens itself is a drawer in the way.
      drawerOpen: false,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : base.width),
      seededFor: typeof parsed.seededFor === 'string' ? parsed.seededFor : '',
      seed:
        parsed.seed && Array.isArray(parsed.seed.primary)
          ? {
              primary: parsed.seed.primary,
              expandAll: parsed.seed.expandAll === true,
              ...(Array.isArray(parsed.seed.only) ? { only: parsed.seed.only } : {}),
            }
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
    const { drawerOpen: _session, ...persisted } = next
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...persisted }))
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

/**
 * Visibility with the seed's `only` preset applied: an explicit user choice
 * always wins; under a preset, a row stays on screen when any of the kinds it
 * answers to is listed (a row may match through its own panelKind or its
 * device class — see presetPanelKinds), and hides otherwise, kindless rows
 * included; with no preset, rows default to shown.
 */
export function effectiveHiddenIn(
  current: DockState,
  key: string,
  kinds?: PanelKind | readonly PanelKind[],
): boolean {
  const override = current.devices[key]?.hidden
  if (override !== undefined) return override
  const only = current.seed.only
  if (only !== undefined) {
    const list = kinds === undefined ? [] : Array.isArray(kinds) ? kinds : [kinds]
    return !list.some((kind: PanelKind) => only.includes(kind))
  }
  return false
}

export function effectiveHidden(key: string, kinds?: PanelKind | readonly PanelKind[]): boolean {
  return effectiveHiddenIn(state, key, kinds)
}

export function setView(view: DockView): void {
  if (state.view !== view) set({ ...state, view })
}

export function setOpen(open: boolean): void {
  if (state.open !== open) set({ ...state, open })
}

export function setDrawerOpen(drawerOpen: boolean): void {
  if (state.drawerOpen !== drawerOpen) set({ ...state, drawerOpen })
}

/**
 * Put the dock on screen whichever shape it currently has — what a caller
 * outside the layout (revealDockRow, a shortcut, Reset layout) actually means.
 */
export function showDock(): void {
  if (state.open && state.drawerOpen) return
  set({ ...state, open: true, drawerOpen: true })
}

export function setWidth(width: number): void {
  const clamped = clampWidth(width)
  if (state.width !== clamped) set({ ...state, width: clamped })
}

function patchDevice(key: string, patch: DockDeviceState): void {
  const merged: DockDeviceState = { ...state.devices[key], ...patch }
  // Drop keys that carry no information, so the record stays small. Expanded
  // and hidden are tri-state (an explicit false overrides the seed), windowed
  // has no seed to override so false is just absence.
  for (const field of ['expanded', 'hidden', 'windowed'] as const) {
    if (merged[field] === undefined || (field === 'windowed' && merged[field] === false)) {
      delete merged[field]
    }
  }
  if (merged.sections !== undefined && Object.keys(merged.sections).length === 0) {
    delete merged.sections
  }
  if (merged.tab === undefined || merged.tab === '') {
    delete merged.tab
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
  // With no `only` preset in play, shown is the default — "not hidden" is
  // absence, and the record stays small. Under a preset, re-showing a row the
  // preset hides needs an explicit false to override it.
  if (!hidden && state.seed.only === undefined) {
    patchDevice(key, { hidden: undefined })
    return
  }
  patchDevice(key, { hidden })
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

/** Persist the selected tab inside an instrument body (Debug / Trace). */
export function setTab(deviceKey: string, tab: string): void {
  if (state.devices[deviceKey]?.tab === tab) return
  patchDevice(deviceKey, { tab })
}

/** Pure read of a stored tab id, falling back when unset or not allowlisted. */
export function tabIn(
  current: DockState,
  deviceKey: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const raw = current.devices[deviceKey]?.tab
  return raw !== undefined && allowed.includes(raw) ? raw : fallback
}

export function getTab(deviceKey: string, allowed: readonly string[], fallback: string): string {
  return tabIn(state, deviceKey, allowed, fallback)
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
 * overrides are cleared so the new sample's defaults speak; visibility,
 * pop-out, section, and tab choices persist — they are about the user's
 * screen, not the guest.
 */
export function seedForSelection(selection: string, seed: DockSeed): void {
  const sameOnly =
    (state.seed.only === undefined) === (seed.only === undefined) &&
    (state.seed.only?.length ?? 0) === (seed.only?.length ?? 0) &&
    (state.seed.only ?? []).every((kind, i) => seed.only?.[i] === kind)
  if (state.seededFor === selection) {
    const same =
      sameOnly &&
      state.seed.expandAll === seed.expandAll &&
      state.seed.primary.length === seed.primary.length &&
      state.seed.primary.every((kind, i) => seed.primary[i] === kind)
    if (!same) set({ ...state, seed })
    return
  }
  // Visibility choices normally outlive the selection (they are about the
  // user's screen), but ones made against a Learn preset are about that
  // preset: entering or leaving `only` drops them along with expansion.
  const dropHidden = state.seed.only !== undefined || seed.only !== undefined
  const devices: Record<string, DockDeviceState> = {}
  for (const [key, value] of Object.entries(state.devices)) {
    const { expanded: _cleared, hidden, ...rest } = value
    const kept: DockDeviceState = dropHidden ? rest : { ...rest, hidden }
    if (kept.hidden === undefined) delete kept.hidden
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
  // Keep the current selection's seed so default expansion still applies, and
  // whether the dock is currently on screen — Reset layout is about the panels.
  const { seededFor, seed, drawerOpen } = state
  set({ ...defaults(), seededFor, seed, drawerOpen })
}

/** Re-run migration + load. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  migratePanelLayoutKeys()
  state = load()
  notify()
}
