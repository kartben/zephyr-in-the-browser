/**
 * The dock's "Try it" hint: one line on what to do with the running sample,
 * and a chip for each dock row that line is about.
 *
 * A first visit lands on a terminal and a column of device rows, and nothing
 * on screen says which of them matters, or what to type. Every sample already
 * carries a curated line in src/boards.ts; this is where the dock says it.
 * The line is the sample's `tryIt` when it has one, and its `description`
 * otherwise: most descriptions already read as something to do ("Press SW0 in
 * the dock"), and `tryIt` is for the ones written as a spec.
 *
 * The hint is the sample's, so dismissing it is per sample: the selection key
 * the dock seeds by (`board:sample`), kept in one versioned localStorage key.
 * The Panels menu is the way back. A module-level store, the dockTarget idiom.
 */

import { sampleForSeed, type GuestSample, type PanelKind } from '@/boards'
import type { DeviceClass, DeviceNode } from '@/deviceTopology'
import { STAGE_DEBUG_KEY, STAGE_PERF_KEY, STAGE_TRACE_KEY } from '@/lib/dockStore'

const STORAGE_KEY = 'zephyr.tryIt'
const VERSION = 1

/** What the strip says for a sample. */
export function tryItLine(sample: GuestSample): string {
  return sample.tryIt ?? sample.description
}

/**
 * The sample the strip speaks for, with its line, or null when there is no
 * hint to show: no curated sample (a dropped ELF, a Live board session), the
 * reader dismissed it, or a guided tour is under way (`touring`, see the tour
 * store's tourInProgress). The tour's cards are the guidance while it runs;
 * the hint comes back when the tour is over or left.
 */
export function tryItFor(
  selection: string,
  dismissed: ReadonlySet<string>,
  touring: boolean,
): { sample: GuestSample; line: string } | null {
  const sample = sampleForSeed(selection)
  if (!sample || dismissed.has(selection) || touring) return null
  return { sample, line: tryItLine(sample) }
}

/** A row a chip reveals. */
export interface TryItTarget {
  kind: PanelKind
  /** Dock row key: a device's inventory key, or an instrument's `stage:` key. */
  key: string
  /** Lets reveal unfold the row's class group in the Classes view. */
  deviceClass?: DeviceClass
  /** The device behind the row; absent for an instrument. */
  node?: DeviceNode
}

/** Instruments are rows too, found by their fixed keys (as in dockReveal). */
const INSTRUMENT_KEYS: Partial<Record<PanelKind, string>> = {
  perf: STAGE_PERF_KEY,
  trace: STAGE_TRACE_KEY,
  debug: STAGE_DEBUG_KEY,
}

/**
 * The rows a sample's chips point at, in its `primaryPanels` order.
 *
 * Only rows a reader can open: a device the guest actually has, live
 * (`presence: 'interactive'`), or an instrument `offered` says has something
 * to show. A kind with neither gets no chip rather than one that reveals
 * nothing, and two kinds that land on one row get one chip.
 *
 * Devices are looked up before instruments, unlike dockReveal's panelKindRow:
 * the ESP32-C3's sleep samples name `perf` for their power card, which is a
 * device row, while the Simulation instrument behind the same kind has nothing
 * to say about sleep.
 */
export function tryItTargets(
  kinds: readonly PanelKind[],
  nodes: readonly DeviceNode[],
  offered: (kind: PanelKind) => boolean = () => true,
): TryItTarget[] {
  const targets: TryItTarget[] = []
  for (const kind of kinds) {
    const node = nodes.find((n) => n.panelKind === kind && n.presence === 'interactive')
    const instrument = INSTRUMENT_KEYS[kind]
    const target: TryItTarget | null = node
      ? { kind, key: node.key, deviceClass: node.deviceClass, node }
      : instrument && offered(kind)
        ? { kind, key: instrument }
        : null
    if (target && !targets.some((t) => t.key === target.key)) targets.push(target)
  }
  return targets
}

/** Split a line on its `code` spans: odd-indexed parts are code. */
export function splitCode(line: string): string[] {
  return line.split('`')
}

/* ------------------------------------------------------------------ *
 * Dismissed hints, per selection
 * ------------------------------------------------------------------ */

const NONE: ReadonlySet<string> = new Set()

function load(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return NONE
    const parsed = JSON.parse(raw) as { v?: number; dismissed?: unknown }
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.dismissed)) return NONE
    return new Set(parsed.dismissed.filter((s): s is string => typeof s === 'string'))
  } catch {
    return NONE // private mode, blocked storage, or a value we did not write
  }
}

function save(next: ReadonlySet<string>): void {
  try {
    if (next.size === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, dismissed: [...next] }))
  } catch {
    /* storage full or blocked: the hint just comes back on the next visit */
  }
}

let dismissed: ReadonlySet<string> = load()
const listeners = new Set<() => void>()

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The dismissed selections; a new Set on every change (useSyncExternalStore). */
export function getDismissed(): ReadonlySet<string> {
  return dismissed
}

/** Hide (or bring back) the hint for one selection, `board:sample`. */
export function setTryItDismissed(selection: string, hide: boolean): void {
  if (dismissed.has(selection) === hide) return
  const next = new Set(dismissed)
  if (hide) next.add(selection)
  else next.delete(selection)
  dismissed = next
  save(next)
  for (const fn of listeners) fn()
}

/** Re-read storage. For tests. */
export function reloadFromStorage(): void {
  dismissed = load()
  for (const fn of listeners) fn()
}
