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
import {
  blinkDockRow,
  panelKindRow,
  revealDockRow,
  revealPanelKind,
  type RevealOptions,
} from '@/lib/dockReveal'
import { STAGE_DEBUG_KEY, STAGE_TRACE_KEY, getState, setTab } from '@/lib/dockStore'
import { setDockTargets, type DockTarget } from '@/lib/dockTarget'
import * as ipcUi from '@/lib/ipcUi'
import { getMode } from '@/lib/modeStore'
import type { LookSpec, TourStep } from '@/tours/parse'

/** The card's line for a step that points at Trace on a guest without it. */
export const NO_TRACE_NOTE = 'This view needs the traced build of this sample.'

/**
 * How long after a card lands the rows it points at blink: long enough for the
 * reader's eye to have gone to the card, so the blink is a second thing to
 * notice rather than part of the first.
 */
export const BLINK_AFTER_MS = 400

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
export function focusLook(look: LookSpec, opts: RevealOptions = {}): void {
  switch (look.kind) {
    case 'trace':
      // The tab first, so the row expands onto it rather than switching after.
      setTab(STAGE_TRACE_KEY, look.tab)
      // The graph shows what the step points at: one object, or all of it, not
      // whatever the reader last narrowed it to.
      if (look.focus) ipcUi.focusIpcObject(look.focus)
      else if (look.tab === 'queues') ipcUi.clearIpcFilter()
      revealDockRow(STAGE_TRACE_KEY, undefined, opts)
      return
    case 'debug':
      debugUi.focusDebug(look.section, opts)
      return
    case 'dock':
      revealPanelKind(look.panel, opts)
      return
  }
}

/**
 * Open everything a step points at, in the order written.
 *
 * A Trace view on a guest without Trace is skipped: there is no row to show,
 * and revealing one would only open the dock onto nothing. The card says why
 * instead (see lookNotes).
 *
 * Quietly: this runs just before the step's card lands, and a blink then is
 * lost under the card's arrival. The card blinks the rows once it is up; see
 * pointAt.
 */
export function focusStep(step: Pick<TourStep, 'panel' | 'look'>): void {
  const trace = traceOffered()
  for (const look of looksOf(step)) {
    if (needsTrace(look) && !trace) continue
    focusLook(look, { quiet: true })
  }
}

/** What the card should say about views this guest cannot show. */
export function lookNotes(step: Pick<TourStep, 'panel' | 'look'>): string[] {
  return looksOf(step).some(needsTrace) && !traceOffered() ? [NO_TRACE_NOTE] : []
}

/**
 * The dock rows a step points at, with the tab inside each it names.
 *
 * Trace is listed whether or not this guest has it: a row that is not in the
 * dock has nothing to ring, and one that turns up while the card is still on
 * screen is ringed when it does. A `panel:` naming a part this board does not
 * have has no row, so it adds nothing.
 */
export function lookTargets(step: Pick<TourStep, 'panel' | 'look'>): DockTarget[] {
  const targets: DockTarget[] = []
  const add = (target: DockTarget) => {
    if (!targets.some((t) => t.key === target.key && t.tab === target.tab)) targets.push(target)
  }
  for (const look of looksOf(step)) {
    switch (look.kind) {
      case 'trace':
        add({ key: STAGE_TRACE_KEY, tab: look.tab })
        break
      case 'debug':
        add({ key: STAGE_DEBUG_KEY, tab: look.section })
        break
      case 'dock': {
        const row = panelKindRow(look.panel)
        if (row) add({ key: row.key })
        break
      }
    }
  }
  return targets
}

/**
 * Whether all the step points at in Trace is an IPC object the graph has no
 * node for yet: the row then only says the object has no traffic, which is
 * worth reading but not worth a blink. The graph turns a name into a focus as
 * soon as the object shows up, so a name still pending is one it has not seen.
 */
function traceWaiting(step: Pick<TourStep, 'panel' | 'look'>): boolean {
  const traces = looksOf(step).filter(needsTrace)
  const pending = ipcUi.getSnapshot().focusName
  return (
    traces.length > 0 &&
    traces.every((look) => look.kind === 'trace' && look.focus != null && look.focus === pending)
  )
}

/**
 * Point the dock at what the card on screen is about.
 *
 * The rows the step names keep a ring for as long as its card is up, folded
 * to one line or not, and blink once the card has landed: the card is the
 * what, the dock is the where, and the ring is how the eye gets from one to
 * the other. Trace waiting on an object with no traffic yet keeps its ring
 * but blinks only once the object turns up, if the card is still there.
 * Call it as a card lands, with its step, or with null when no step's card is
 * up. It returns what undoes it, for when that card goes.
 */
export function pointAt(step: Pick<TourStep, 'panel' | 'look'> | null): () => void {
  const targets = step ? lookTargets(step) : []
  setDockTargets(targets)
  if (!step || targets.length === 0) return () => {}
  let unsubscribe = () => {}
  const timer = setTimeout(() => {
    const waiting = traceWaiting(step)
    for (const key of new Set(targets.map((target) => target.key))) {
      if (!(waiting && key === STAGE_TRACE_KEY)) blinkDockRow(key)
    }
    if (!waiting) return
    unsubscribe = ipcUi.subscribe(() => {
      const filter = ipcUi.getSnapshot()
      if (filter.focusName !== null) return
      unsubscribe()
      // Found, not the reader clearing the filter with "Show everything".
      if (filter.focus !== null) blinkDockRow(STAGE_TRACE_KEY)
    })
  }, BLINK_AFTER_MS)
  return () => {
    clearTimeout(timer)
    unsubscribe()
    setDockTargets([])
  }
}
