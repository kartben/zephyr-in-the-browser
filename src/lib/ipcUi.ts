/**
 * What the reader narrowed Trace → IPC to: object kinds switched off, part of a
 * name, and the node the graph is focused on.
 *
 * A module-level store, the debugUi idiom, rather than state in the graph: the
 * graph unmounts whenever another Trace tab is picked, and a filter that reset
 * on every look at the Timeline would be one nobody bothers to set. It is not
 * saved across reloads, where it would hide whatever the next tour points at.
 */

export interface IpcFilter {
  /** Object kinds (`msgq`, `fifo`, …) switched off with their chips. */
  hiddenKinds: ReadonlySet<string>
  /** Part of a thread or object name. */
  query: string
  /** Graph node id (`thread:…`, `object:…`) the graph is focused on. */
  focus: string | null
  /** Show the semaphores, mutexes and condvars only one thread or ISR uses. */
  showPrivate: boolean
}

export const NO_IPC_FILTER: IpcFilter = {
  hiddenKinds: new Set(),
  query: '',
  focus: null,
  showPrivate: false,
}

let state: IpcFilter = NO_IPC_FILTER
const listeners = new Set<() => void>()

function set(next: IpcFilter): void {
  state = next
  for (const fn of listeners) fn()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot(): IpcFilter {
  return state
}

export function isFiltered(filter: IpcFilter): boolean {
  return filter.hiddenKinds.size > 0 || filter.query.trim() !== '' || filter.focus !== null
}

/** Focus the graph on one node, or pass null to see all of it again. */
export function setIpcFocus(nodeId: string | null): void {
  if (state.focus !== nodeId) set({ ...state, focus: nodeId })
}

export function toggleIpcKind(kind: string): void {
  const hiddenKinds = new Set(state.hiddenKinds)
  if (!hiddenKinds.delete(kind)) hiddenKinds.add(kind)
  set({ ...state, hiddenKinds })
}

export function setIpcQuery(query: string): void {
  if (state.query !== query) set({ ...state, query })
}

export function toggleIpcPrivate(): void {
  set({ ...state, showPrivate: !state.showPrivate })
}

export function clearIpcFilter(): void {
  if (isFiltered(state) || state.showPrivate) set(NO_IPC_FILTER)
}
