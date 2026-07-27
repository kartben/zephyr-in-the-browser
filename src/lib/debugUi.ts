/**
 * Focus handoff for the Debug stage panel (PC chip → CPU, etc.).
 * Tiny module-level store — same idiom as dockStore / hostGnss.
 */

import {
  STAGE_DEBUG_KEY,
  setExpanded,
  setHidden,
} from '@/lib/dockStore'
import { revealStagePanel } from '@/lib/dockReveal'

export type DebugSection = 'breakpoints' | 'cpu' | 'memory' | 'threads'

export interface DebugUiState {
  /** Bumped on every focus request so subscribers re-render even for the same tab. */
  nonce: number
  section: DebugSection
}

let state: DebugUiState = { nonce: 0, section: 'breakpoints' }
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

/** Open/focus the Debug panel on a section (defaults to breakpoints). */
export function focusDebug(section: DebugSection = 'breakpoints'): void {
  setHidden(STAGE_DEBUG_KEY, false)
  setExpanded(STAGE_DEBUG_KEY, true)
  state = { nonce: state.nonce + 1, section }
  notify()
  revealStagePanel(STAGE_DEBUG_KEY)
}
