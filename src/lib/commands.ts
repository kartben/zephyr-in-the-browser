/**
 * Thin command bus for actions that live in React (Restart, open Samples, …)
 * rather than a module-level store. Shortcuts call `runCommand`; components
 * register a handler on mount. Same subscribe/notify spirit as the stores,
 * without inventing another localStorage blob.
 */

export type AppCommand = 'restart' | 'open-samples' | 'open-settings' | 'open-learn'

const handlers = new Map<AppCommand, Set<() => void>>()

/** Register a handler; returns an unsubscribe. Multiple listeners are fan-out. */
export function registerCommand(id: AppCommand, fn: () => void): () => void {
  let set = handlers.get(id)
  if (!set) {
    set = new Set()
    handlers.set(id, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) handlers.delete(id)
  }
}

export function runCommand(id: AppCommand): void {
  const set = handlers.get(id)
  if (!set) return
  for (const fn of [...set]) fn()
}
