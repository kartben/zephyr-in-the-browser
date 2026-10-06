/**
 * The Trace instrument's tabs: the id each is stored under, the label it
 * shows, and the name a tour uses to open it.
 *
 * Kept apart from TracePanel so a tour can be checked and focused without
 * pulling the panel and its charts in with it.
 */

/** Tab ids, in strip order. dockStore persists the selected one. */
export const TRACE_TABS = ['schedule', 'queues', 'zbus', 'net', 'power'] as const

export type TraceTab = (typeof TRACE_TABS)[number]

export const TRACE_TAB_LABELS: Record<TraceTab, string> = {
  schedule: 'Timeline',
  queues: 'IPC',
  zbus: 'zbus',
  net: 'Networking',
  power: 'Power',
}

/**
 * Where a tour's name for a tab is not its id. The Timeline was the schedule
 * view before it had a label, and IPC was Queues before it drew more than
 * queues; stored layouts still say so, and a tour should not have to know that.
 */
const TOUR_NAMES: Partial<Record<TraceTab, string>> = { schedule: 'timeline', queues: 'ipc' }

/** What a tour writes after `trace.` to open a tab. */
export function traceTabTourName(tab: TraceTab): string {
  return TOUR_NAMES[tab] ?? tab
}

/** The tab a tour's `trace.<name>` opens, or null when there is none. */
export function traceTabFromTourName(name: string): TraceTab | null {
  return TRACE_TABS.find((tab) => traceTabTourName(tab) === name) ?? null
}
