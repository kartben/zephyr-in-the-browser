/**
 * Reveal a dock device row: unhide, open the fold and class group it sits in,
 * expand the row itself, scroll it into view, and pulse an attention blink on
 * its header.
 */

import type { PanelKind } from '@/boards'
import { usableNodes, type DeviceClass, type DeviceInventory } from '@/deviceTopology'
import { isLeadNode } from '@/lib/dockSections'
import {
  STAGE_DEBUG_KEY,
  STAGE_PERF_KEY,
  STAGE_TRACE_KEY,
  getState,
  setExpanded,
  setGroupCollapsed,
  setHidden,
  setMoreOpen,
  setView,
  showDock,
} from '@/lib/dockStore'

const BLINK_MS = 900
const BLINK_STATIC_MS = 600

/** CSS.escape polyfill for older engines — keys are simple today. */
function escapeKey(key: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(key)
  return key.replace(/"/g, '\\"')
}

/**
 * Scroll one element into view and blink it, honouring reduced motion.
 *
 * The same gesture a dock row gets, on anything: a thread in the Threads list,
 * a semaphore in the Objects list. Exported because "show me *that* one" is the
 * whole point of a handoff, and three copies of the timing had already started
 * to appear.
 */
export function pulseElement(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  el.classList.remove('dock-row-attention', 'dock-row-attention-static')
  // Force restart if re-clicked mid-blink.
  void el.offsetWidth
  const reduce =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  el.classList.add(reduce ? 'dock-row-attention-static' : 'dock-row-attention')
  window.setTimeout(
    () => {
      el.classList.remove('dock-row-attention', 'dock-row-attention-static')
    },
    reduce ? BLINK_STATIC_MS : BLINK_MS,
  )
}

export interface RevealOptions {
  /**
   * Open the row and scroll to it, but neither blink it nor move the keyboard
   * focus to it. A tour step opens what it points at just before its card
   * lands, and a blink then is one the reader misses: the card arriving is the
   * stronger change. The card blinks the row itself once it is up (see
   * blinkDockRow), and the focus stays where the reader left it.
   */
  quiet?: boolean
}

/**
 * Bring a dock row — device or instrument — into view and briefly highlight it.
 * A row the ▤ view leaves out (nothing to use on it, see usableNodes) is shown
 * in the devicetree view instead, which lists every node. In the ▤ view a
 * device the sample does not lead with sits in the "More on this board" fold
 * (lib/dockSections), which opens, and so does its class group when
 * `deviceClass` names it.
 *
 * A row that is popped out is left where it is: PanelFrame stamps the same
 * `data-dock-key` on its floating card, so the blink finds it there.
 */
export function revealDockRow(
  key: string,
  deviceClass?: DeviceClass,
  opts: RevealOptions = {},
): void {
  const state = getState()
  if (state.devices[key]?.windowed !== true) showDock()
  if (state.devices[key]?.hidden) setHidden(key, false)
  if (state.view === 'classes' && leftOutOfClasses(key)) setView('devicetree')
  if (getState().view === 'classes' && inMoreFold(key)) {
    setMoreOpen(true)
    if (deviceClass) setGroupCollapsed(deviceClass, false)
  }
  setExpanded(key, true)
  pulseDockKey(key, opts.quiet === true)
}

function pulseDockKey(key: string, quiet: boolean): void {
  // Wait a frame so expand/unhide have committed to the DOM.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-dock-key="${escapeKey(key)}"]`)
      if (!el) return
      if (quiet) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        return
      }
      const focusTarget =
        el.querySelector<HTMLElement>('[data-dock-focus]') ??
        el.querySelector<HTMLElement>('button') ??
        el
      focusTarget.focus({ preventScroll: true })
      pulseElement(el)
    })
  })
}

/**
 * Blink a dock row where it already is: no expanding, and no focus taken.
 *
 * What a tour card does once it has landed, to the rows its step opened. Every
 * element with the key blinks, so a row popped out into a window blinks there
 * as well as in the dock.
 */
export function blinkDockRow(key: string): void {
  if (typeof document === 'undefined') return
  for (const el of document.querySelectorAll<HTMLElement>(`[data-dock-key="${escapeKey(key)}"]`)) {
    pulseElement(el)
  }
}

/*
 * The dock's current inventory, published by hooks/useDeviceTree.
 *
 * Callers outside React — an annotation naming a panel it wants looked at —
 * know a PanelKind, not a row key. Resolving one to the other needs the
 * inventory, which only exists inside the hook that derives it, so the hook
 * hands it over here.
 */
let inventory: DeviceInventory | null = null
const inventoryListeners = new Set<() => void>()

export function publishInventory(next: DeviceInventory): void {
  inventory = next
  for (const fn of inventoryListeners) fn()
}

export function getInventory(): DeviceInventory | null {
  return inventory
}

/** Whether `key` is a device row the ▤ view does not list. */
function leftOutOfClasses(key: string): boolean {
  const nodes = inventory?.nodes
  if (!nodes || !nodes.some((node) => node.key === key)) return false
  return !usableNodes(nodes, getState().seed.primary).nodes.some((node) => node.key === key)
}

export function subscribeInventory(fn: () => void): () => void {
  inventoryListeners.add(fn)
  return () => inventoryListeners.delete(fn)
}

/**
 * Whether the ▤ view keeps this row in its "More on this board" fold: a device
 * the running sample is not about. Instruments are not inventory nodes, and
 * never fold.
 */
function inMoreFold(key: string): boolean {
  const node = inventory?.nodes.find((n) => n.key === key)
  return node !== undefined && !isLeadNode(node, getState().seed.primary)
}

/**
 * The instruments are dock rows too, but not inventory nodes: nothing in the
 * devicetree declares them, so they are found by their fixed keys instead.
 */
const INSTRUMENT_ROWS = new Map<PanelKind, string>([
  ['perf', STAGE_PERF_KEY],
  ['trace', STAGE_TRACE_KEY],
  ['debug', STAGE_DEBUG_KEY],
])

/**
 * The row that represents a panel kind, or null when there is none.
 *
 * Prefers an interactive row: `led` matches both the LED indicators and a
 * ghost row for a part nothing answers for, and pointing the reader at the
 * ghost would be worse than pointing at nothing. The sample may also name a
 * peripheral this board does not have, which has no row at all.
 */
export function panelKindRow(kind: string): { key: string; deviceClass?: DeviceClass } | null {
  const instrument = INSTRUMENT_ROWS.get(kind as PanelKind)
  if (instrument) return { key: instrument }
  const nodes = inventory?.nodes
  if (!nodes) return null
  const matches = nodes.filter((node) => node.panelKind === (kind as PanelKind))
  if (matches.length === 0) return null
  const node = matches.find((n) => n.presence === 'interactive') ?? matches[0]
  return { key: node.key, deviceClass: node.deviceClass }
}

/** Reveal the row that represents a panel kind; a no-op when it has none. */
export function revealPanelKind(kind: string, opts: RevealOptions = {}): void {
  const row = panelKindRow(kind)
  if (row) revealDockRow(row.key, row.deviceClass, opts)
}
