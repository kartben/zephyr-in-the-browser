/**
 * Learn progress: which curriculum steps are done, and which one is running.
 * One versioned localStorage key (`zephyr.learn`), the modeStore idiom.
 *
 * `done` is keyed by step id, never by position, so reordering a track or
 * inserting a step cannot shuffle anyone's ticks; ids that no longer exist in
 * the catalog are kept, so a step temporarily pulled from a track keeps its
 * mark for when it returns. `active` is written before any navigation — a
 * committed QEMU document reloads on selection change, and the dock preset
 * and the "running now" marker have to survive that.
 */

const STORAGE_KEY = 'zephyr.learn'
const VERSION = 1

export interface LearnProgress {
  /** Step ids the user marked done. */
  done: ReadonlySet<string>
  /** The step the user last started, until the selection moves off it. */
  activeStepId: string | null
}

interface Stored {
  done: Set<string>
  active: string | null
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { done: new Set(), active: null }
    const parsed = JSON.parse(raw) as { v?: number; done?: unknown; active?: unknown }
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) {
      return { done: new Set(), active: null }
    }
    const done = new Set(
      Array.isArray(parsed.done)
        ? parsed.done.filter((id): id is string => typeof id === 'string')
        : [],
    )
    return { done, active: typeof parsed.active === 'string' ? parsed.active : null }
  } catch {
    return { done: new Set(), active: null }
  }
}

function save(stored: Stored): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: VERSION, done: [...stored.done].sort(), active: stored.active }),
    )
  } catch {
    /* storage full or blocked — progress just won't survive the reload */
  }
}

let stored: Stored = load()
let snapshot: LearnProgress = { done: stored.done, activeStepId: stored.active }
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = { done: stored.done, activeStepId: stored.active }
  save(stored)
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Immutable snapshot; a new object on every change (useSyncExternalStore). */
export function getSnapshot(): LearnProgress {
  return snapshot
}

/** The "Mark as done" toggle. Idempotent in both directions. */
export function setStepDone(id: string, done: boolean): void {
  if (stored.done.has(id) === done) return
  const next = new Set(stored.done)
  if (done) next.add(id)
  else next.delete(id)
  stored = { ...stored, done: next }
  publish()
}

/** Record the step being started (or clear it when the selection moves off). */
export function setActiveStep(id: string | null): void {
  if (stored.active === id) return
  stored = { ...stored, active: id }
  publish()
}

/** Re-read localStorage. For tests, and after external storage edits. */
export function reloadFromStorage(): void {
  stored = load()
  snapshot = { done: stored.done, activeStepId: stored.active }
  for (const fn of listeners) fn()
}
