/**
 * Walkthrough state for the running sample.
 *
 * Records arrive from the guest (attach.ts), prose from the catalog, and this
 * joins them: which annotations this build linked in, which one the reader is
 * looking at, which are already behind them. The dock reveal and the machine
 * pause are both driven from here, so the card stays a view.
 *
 * Module-level store plus subscribe/getSnapshot, read through
 * useSyncExternalStore — the same shape as dockStore, devicetree and hostNet.
 */

import { loadCatalog, type AnnotationCatalog, type CatalogEntry } from '@/annotations/catalog'
import type { AnnotationRecord } from '@/annotations/protocol'
import * as monitor from '@/hostMonitor'
import { revealPanelKind } from '@/lib/dockReveal'

const ENABLED_KEY = 'zephyr-annotations-enabled'

export interface AnnotationView {
  entry: CatalogEntry
  /** 1-based position in the outline. */
  step: number
  total: number
  /** The machine was stopped for this one. */
  paused: boolean
  /** Latest SAMPLE_VALUE() text, when the sample has sent one. */
  value?: string
}

export interface AnnotationState {
  /** The running build announced a table, so this sample is annotated. */
  active: boolean
  /** The reader has not turned walkthroughs off. */
  enabled: boolean
  catalog: AnnotationCatalog | null
  /** Ids the running build linked in, in source order. */
  outline: number[]
  /** Ids already shown. */
  seen: Set<number>
  /** What the card is showing, or null. */
  current: AnnotationView | null
  /** SAMPLE_END() has been reached. */
  finished: boolean
  /**
   * The boot table disagreed with annotations.json about where an annotation
   * points. They are separate artifacts fetched separately, so one can be
   * stale; say so rather than highlighting the wrong line.
   */
  drift: boolean
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true // private mode, blocked storage
  }
}

const EMPTY: AnnotationState = {
  active: false,
  enabled: true,
  catalog: null,
  outline: [],
  seen: new Set(),
  current: null,
  finished: false,
  drift: false,
}

let state: AnnotationState = { ...EMPTY, enabled: readEnabled() }
/** Ids announced since the last table record, before the count closes it. */
let pending: Array<{ id: number; line: number }> = []
const values = new Map<number, string>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function publish(next: Partial<AnnotationState>) {
  state = { ...state, ...next }
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): AnnotationState {
  return state
}

/** Point the store at the running sample's catalog. Safe to call when absent. */
export async function loadFor(assetUrl: string): Promise<void> {
  const catalog = await loadCatalog(assetUrl)
  publish({ catalog })
}

function viewFor(id: number, paused: boolean): AnnotationView | null {
  const entry = state.catalog?.byId.get(id)
  if (!entry) return null
  const step = state.outline.indexOf(id)
  return {
    entry,
    step: step >= 0 ? step + 1 : state.seen.size + 1,
    total: state.outline.length,
    paused,
    value: values.get(id),
  }
}

/** Close the boot announcement: the outline is everything the build linked. */
function commitTable(count: number) {
  const outline = pending.map((p) => p.id)
  const catalog = state.catalog
  // A line mismatch means the JSON and the ELF came from different builds.
  const drift =
    catalog !== null &&
    (count !== outline.length ||
      pending.some((p) => {
        const entry = catalog.byId.get(p.id)
        return entry !== undefined && entry.line !== p.line
      }))
  pending = []
  publish({ active: outline.length > 0, outline, drift, finished: false })
}

function show(id: number, pause: boolean) {
  if (!state.enabled) return
  const view = viewFor(id, pause)
  if (!view) return

  // Reveal before pausing, so the row is already in view when the machine
  // stops and the reader's eye has somewhere to go.
  if (view.entry.panel) revealPanelKind(view.entry.panel)
  if (pause) monitor.pause()

  const seen = new Set(state.seen)
  seen.add(id)
  publish({ current: view, seen })
}

/**
 * Fold one guest record into the store.
 *
 * Records for ids the catalog has never heard of are dropped: that is what an
 * annotated ELF with a missing or stale annotations.json looks like, and it
 * must not produce an empty popup.
 */
export function handleRecord(record: AnnotationRecord): void {
  switch (record.kind) {
    case 'ann':
      pending.push({ id: record.id, line: record.line })
      break
    case 'table':
      commitTable(record.count)
      break
    case 'show':
      show(record.id, record.pause)
      break
    case 'reveal':
      if (state.enabled) revealPanelKind(record.panel)
      break
    case 'value': {
      values.set(record.id, record.text)
      if (state.current?.entry.id === record.id) {
        publish({ current: { ...state.current, value: record.text } })
      }
      break
    }
    case 'end':
      publish({ finished: true })
      break
  }
}

/**
 * Re-open an annotation the reader has already passed.
 *
 * Never pauses, whatever the original record said: the machine has moved on,
 * and stopping it now would freeze the guest somewhere unrelated to what is on
 * screen. Reading back is a look at the notes, not a rewind.
 */
export function revisit(id: number) {
  if (!state.seen.has(id)) return
  const view = viewFor(id, false)
  if (view) publish({ current: view })
}

/** Dismiss the current annotation and let the machine run on. */
export function dismiss() {
  if (state.current?.paused) monitor.resume()
  publish({ current: null })
}

/**
 * Turn walkthroughs off for good (or back on).
 *
 * Turning them off has to resume a machine stopped by an annotation, or the
 * reader is left with a frozen guest and nothing on screen explaining why.
 */
export function setEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
  } catch {
    // Preference is a nicety; the toggle still works for this session.
  }
  if (!enabled && state.current?.paused) monitor.resume()
  publish({ enabled, current: enabled ? state.current : null })
}

/** Drop everything — a new guest is starting. */
export function reset() {
  pending = []
  values.clear()
  state = { ...EMPTY, enabled: state.enabled, seen: new Set() }
  notify()
}
