/**
 * Reveal a dock device row: unhide, expand its class group and the row itself,
 * scroll it into view, and pulse an attention blink on its header.
 */

import type { PanelKind } from '@/boards'
import type { DeviceClass, DeviceInventory } from '@/deviceTopology'
import * as hostTrace from '@/hostTrace'
import {
  STAGE_TRACE_KEY,
  getState,
  setExpanded,
  setGroupCollapsed,
  setHidden,
  setTab,
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

/**
 * Bring a dock row — device or instrument — into view and briefly highlight it.
 * `deviceClass` is required in ▤ view so a collapsed class group can open.
 *
 * A row that is popped out is left where it is: PanelFrame stamps the same
 * `data-dock-key` on its floating card, so the blink finds it there.
 */
export function revealDockRow(key: string, deviceClass?: DeviceClass): void {
  const state = getState()
  if (state.devices[key]?.windowed !== true) showDock()
  if (state.devices[key]?.hidden) setHidden(key, false)
  if (
    deviceClass &&
    getState().view === 'classes' &&
    (getState().groups[deviceClass]?.collapsed ?? false)
  ) {
    setGroupCollapsed(deviceClass, false)
  }
  setExpanded(key, true)
  pulseDockKey(key)
}

function pulseDockKey(key: string): void {
  // Wait a frame so expand/unhide have committed to the DOM.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-dock-key="${escapeKey(key)}"]`)
      if (!el) return
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
 * Open the Trace row on one of its tabs, if there is a trace to open it on.
 *
 * Not a `revealPanelKind('trace')`: the inventory holds the board's devices,
 * and Trace is an instrument, so nothing in there answers for it. The tab is
 * part of the ask — "watch the timeline" and "watch the queue depth" are
 * different views of the same stream.
 *
 * CTF comes from the guest's own configuration, so only a build made with the
 * `browser-tracing` snippet has any (the `· traced` samples in the gallery).
 * Blinking an empty panel at a reader would be worse than leaving the dock
 * alone, so an untraced guest makes this a no-op.
 */
export function revealTrace(tab: string): void {
  if (!hostTrace.getSnapshot().available) return
  setTab(STAGE_TRACE_KEY, tab)
  revealDockRow(STAGE_TRACE_KEY)
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

export function subscribeInventory(fn: () => void): () => void {
  inventoryListeners.add(fn)
  return () => inventoryListeners.delete(fn)
}

/**
 * Reveal the row that represents a panel kind.
 *
 * Prefers an interactive row: `led` matches both the LED indicators and a
 * ghost row for a part nothing answers for, and pointing the reader at the
 * ghost would be worse than pointing at nothing. A kind with no row at all is
 * a no-op — the sample may name a peripheral this board does not have.
 */
export function revealPanelKind(kind: string): void {
  const nodes = inventory?.nodes
  if (!nodes) return
  const matches = nodes.filter((node) => node.panelKind === (kind as PanelKind))
  if (matches.length === 0) return
  const node = matches.find((n) => n.presence === 'interactive') ?? matches[0]
  revealDockRow(node.key, node.deviceClass)
}
