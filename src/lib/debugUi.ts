/**
 * Focus handoff for the Debug dock row (PC chip → CPU, Trace lane → Threads).
 * Tiny module-level store — same idiom as dockStore / hostGnss.
 */

import {
  STAGE_DEBUG_KEY,
  setExpanded,
  setHidden,
} from '@/lib/dockStore'
import { revealDockRow } from '@/lib/dockReveal'
import * as debug from '@/debug/control'

export type DebugSection =
  | 'breakpoints'
  | 'cpu'
  | 'stack'
  | 'memory'
  | 'threads'
  | 'objects'

export interface DebugUiState {
  /** Bumped on every focus request so subscribers re-render even for the same tab. */
  nonce: number
  section: DebugSection
  /** Thread TCB address to highlight in the Threads tab (CTF thread_id). */
  threadAddr: number | null
  /** Name fallback when the live list has not caught up yet. */
  threadName: string | null
  /** Kernel object address to highlight in the Objects tab. */
  objectAddr: number | null
}

let state: DebugUiState = {
  nonce: 0,
  section: 'breakpoints',
  threadAddr: null,
  threadName: null,
  objectAddr: null,
}
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): DebugUiState {
  return state
}

/** Open/focus the Debug row on a section (defaults to breakpoints). */
export function focusDebug(section: DebugSection = 'breakpoints'): void {
  setHidden(STAGE_DEBUG_KEY, false)
  setExpanded(STAGE_DEBUG_KEY, true)
  state = {
    nonce: state.nonce + 1,
    section,
    threadAddr: null,
    threadName: null,
    objectAddr: null,
  }
  notify()
  revealDockRow(STAGE_DEBUG_KEY)
}

/**
 * Open Debug → Threads and blink the matching row.
 * Pauses the target when needed so the Threads tab is available.
 * `addr` is the Zephyr TCB pointer (same as CTF `thread_id`).
 */
export function focusDebugThread(addr: number, name?: string | null): void {
  setHidden(STAGE_DEBUG_KEY, false)
  setExpanded(STAGE_DEBUG_KEY, true)
  if (!debug.getSnapshot().paused) debug.pause()
  state = {
    nonce: state.nonce + 1,
    section: 'threads',
    threadAddr: addr,
    threadName: name ?? null,
    objectAddr: null,
  }
  notify()
  revealDockRow(STAGE_DEBUG_KEY)
}

/**
 * Open Debug → Objects and blink the matching object.
 *
 * The counterpart of {@link focusDebugThread}, and the same reasoning: a
 * semaphore or a mutex is a *thing* in the running kernel, so pointing at one
 * means showing it where the rest of its kind are listed — not dropping the
 * reader into a hex window at its address and leaving them to recognise it.
 */
export function focusDebugObject(addr: number): void {
  setHidden(STAGE_DEBUG_KEY, false)
  setExpanded(STAGE_DEBUG_KEY, true)
  if (!debug.getSnapshot().paused) debug.pause()
  state = {
    nonce: state.nonce + 1,
    section: 'objects',
    threadAddr: null,
    threadName: null,
    objectAddr: addr,
  }
  notify()
  revealDockRow(STAGE_DEBUG_KEY)
}
