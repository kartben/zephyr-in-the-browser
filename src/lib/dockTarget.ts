/**
 * The dock rows the tour card on screen is about, ringed for as long as it is
 * up.
 *
 * A card says "In **Trace → IPC**" and opens that row; the open row, and its
 * blink, are where the card's step points. The blink is over in a second,
 * though, and the reader reads for longer. A row named here keeps a steady ring
 * until the card goes, so the eye can get from the card to the dock, and back,
 * at any point in the step.
 *
 * A module-level store, the debugUi idiom: the tour card decides what is on
 * screen (tours/look.ts pointAt), and the rows that draw the ring (DockRowShell,
 * PanelFrame, the Trace and Debug tab strips) only read it.
 */

export interface DockTarget {
  /** The row: a device's inventory key, or an instrument's `stage:` key. */
  key: string
  /** The tab inside it the step names: a Trace tab, or a Debug section. */
  tab?: string
}

const NONE: readonly DockTarget[] = []

let targets: readonly DockTarget[] = NONE
const listeners = new Set<() => void>()

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getDockTargets(): readonly DockTarget[] {
  return targets
}

/** Ring these rows, and only these. An empty list clears the ring. */
export function setDockTargets(next: readonly DockTarget[]): void {
  if (next.length === 0 && targets.length === 0) return
  targets = next.length === 0 ? NONE : next
  for (const fn of listeners) fn()
}

/** Whether the card on screen is about this row. */
export function isDockTargetRow(key: string): boolean {
  return targets.some((target) => target.key === key)
}

/** Whether the card on screen is about this tab of this row. */
export function isDockTargetTab(key: string, tab: string): boolean {
  return targets.some((target) => target.key === key && target.tab === tab)
}
