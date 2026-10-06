/**
 * What a step points at, put in front of the reader as it fires: the dock row
 * its `panel:` names, and the instrument views its `look:` names.
 *
 * Its own module rather than part of dockReveal, which every device panel
 * imports: opening a Debug section goes through debugUi, which imports
 * dockReveal in turn, and knowing whether Trace exists means asking hostTrace.
 */

import * as hostTrace from '@/hostTrace'
import * as debugUi from '@/lib/debugUi'
import { revealDockRow, revealPanelKind } from '@/lib/dockReveal'
import { STAGE_TRACE_KEY, getState, setTab } from '@/lib/dockStore'
import * as ipcUi from '@/lib/ipcUi'
import { getMode } from '@/lib/modeStore'
import type { LookSpec, TourStep } from '@/tours/parse'

/** The card's line for a step that points at Trace on a guest without it. */
export const NO_TRACE_NOTE = 'This view needs the traced build of this sample.'

/**
 * Whether the Trace row is in the dock: the guest writes a trace, a live board
 * streams one, or the sample is a traced build that is about to. The last is
 * read from the dock's seed, which is how a `_trace` twin has its row before
 * the first event: a step at `main()` fires well before the trace file shows
 * up. The same rule the row follows in components/dock/Instruments.tsx.
 */
function traceOffered(): boolean {
  return (
    hostTrace.getSnapshot().available ||
    getMode() === 'live' ||
    getState().seed.primary.includes('trace')
  )
}

function needsTrace(look: LookSpec): boolean {
  return look.kind === 'trace' || (look.kind === 'dock' && look.panel === 'trace')
}

/** A step's `panel:` is a look too: a dock row, and nothing inside it. */
function looksOf(step: Pick<TourStep, 'panel' | 'look'>): LookSpec[] {
  return step.panel ? [{ kind: 'dock', panel: step.panel }, ...step.look] : step.look
}

/** Open one view: a Trace tab, a Debug section, or a dock row. */
export function focusLook(look: LookSpec): void {
  switch (look.kind) {
    case 'trace':
      // The tab first, so the row expands onto it rather than switching after.
      setTab(STAGE_TRACE_KEY, look.tab)
      // The graph shows what the step points at: one object, or all of it, not
      // whatever the reader last narrowed it to.
      if (look.focus) ipcUi.focusIpcObject(look.focus)
      else if (look.tab === 'queues') ipcUi.clearIpcFilter()
      revealDockRow(STAGE_TRACE_KEY)
      return
    case 'debug':
      debugUi.focusDebug(look.section)
      return
    case 'dock':
      revealPanelKind(look.panel)
      return
  }
}

/**
 * Open everything a step points at, in the order written.
 *
 * A Trace view on a guest without Trace is skipped: there is no row to show,
 * and revealing one would only open the dock onto nothing. The card says why
 * instead (see lookNotes).
 */
export function focusStep(step: Pick<TourStep, 'panel' | 'look'>): void {
  const trace = traceOffered()
  for (const look of looksOf(step)) {
    if (needsTrace(look) && !trace) continue
    focusLook(look)
  }
}

/** What the card should say about views this guest cannot show. */
export function lookNotes(step: Pick<TourStep, 'panel' | 'look'>): string[] {
  return looksOf(step).some(needsTrace) && !traceOffered() ? [NO_TRACE_NOTE] : []
}
