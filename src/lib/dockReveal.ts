/**
 * Reveal a dock device row: unhide, expand its class group and the row itself,
 * scroll it into view, and pulse an attention blink on its header.
 */

import type { DeviceClass } from '@/deviceTopology'
import {
  getState,
  setExpanded,
  setGroupCollapsed,
  setHidden,
  setOpen,
} from '@/lib/dockStore'

const BLINK_MS = 900
const BLINK_STATIC_MS = 600

/** CSS.escape polyfill for older engines — keys are simple today. */
function escapeKey(key: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(key)
  return key.replace(/"/g, '\\"')
}

/**
 * Bring a dock (or floating) device into view and briefly highlight it.
 * `deviceClass` is required in ▤ view so a collapsed class group can open.
 */
export function revealDockRow(key: string, deviceClass?: DeviceClass): void {
  const state = getState()
  if (!state.open) setOpen(true)
  if (state.devices[key]?.hidden) setHidden(key, false)
  if (
    deviceClass &&
    getState().view === 'classes' &&
    (getState().groups[deviceClass]?.collapsed ?? false)
  ) {
    setGroupCollapsed(deviceClass, false)
  }
  setExpanded(key, true)

  // Wait a frame so expand/unhide have committed to the DOM.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-dock-key="${escapeKey(key)}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const focusTarget =
        el.querySelector<HTMLElement>('[data-dock-focus]') ??
        el.querySelector<HTMLElement>('button') ??
        el
      focusTarget.focus({ preventScroll: true })

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
    })
  })
}
