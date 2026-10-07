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

/** Whether the trace has anything for each tab that only some traces fill. */
export interface TraceTabData {
  /** The image declares zbus channels. */
  zbus: boolean
  /** A socket_* or net_* event has been seen. */
  net: boolean
  /** The CPU power band has a lane. */
  power: boolean
}

/**
 * The tabs the strip shows, in strip order. Timeline and IPC always do; the
 * others only on a trace that has something for them, the way zbus already
 * waited for an image with channels. Networking and Power on a blinky trace
 * were two empty states one click away. A tab a tour card points at shows
 * anyway (`pinned`), so `look: trace.power` on a guest without power events
 * opens the tab's own explanation rather than leaving the reader on another.
 */
export function visibleTraceTabs(
  data: TraceTabData,
  pinned: (tab: TraceTab) => boolean = () => false,
): TraceTab[] {
  return TRACE_TABS.filter((tab) => {
    if (tab === 'schedule' || tab === 'queues') return true
    return data[tab] || pinned(tab)
  })
}
