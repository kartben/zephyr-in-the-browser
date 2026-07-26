import { loadCatalog, type AnnotationCatalog, type CatalogEntry } from '@/annotations/catalog'
import type { AnnotationRecord } from '@/annotations/protocol'
import * as monitor from '@/hostMonitor'
import { revealPanelKind } from '@/lib/dockReveal'

const ENABLED_KEY = 'zephyr-annotations-enabled'

export interface AnnotationView {
  entry: CatalogEntry
  step: number
  total: number
  paused: boolean
  value?: string
}

export interface AnnotationState {
  active: boolean
  enabled: boolean
  catalog: AnnotationCatalog | null
  outline: number[]
  seen: Set<number>
  current: AnnotationView | null
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
  // Only claim a pause the emulator can actually deliver.
  const view = viewFor(id, pause && monitor.available())
  if (!view) return

  // Reveal before pausing, so the stopped machine already has context.
  if (view.entry.panel) revealPanelKind(view.entry.panel)
  if (pause) monitor.pause()

  const seen = new Set(state.seen)
  seen.add(id)
  publish({ current: view, seen })
}

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

export function revisit(id: number) {
  if (!state.seen.has(id)) return
  const view = viewFor(id, false)
  if (view) publish({ current: view })
}

export function dismiss() {
  if (state.current?.paused) monitor.resume()
  publish({ current: null })
}

export function setEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
  } catch {
    // Preference is a nicety; the toggle still works for this session.
  }
  if (!enabled && state.current?.paused) monitor.resume()
  publish({ enabled, current: enabled ? state.current : null })
}

export function reset() {
  pending = []
  values.clear()
  state = { ...EMPTY, enabled: state.enabled, seen: new Set() }
  notify()
}
