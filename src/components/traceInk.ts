/**
 * The Trace charts' neutral inks, for the scheme the page is in.
 *
 * The Timeline, zbus, Networking and Power tabs paint a canvas and the IPC
 * depth chart is drawn by d3, so their colours are strings handed to a painter,
 * not classes the page's theme can restyle. index.css declares each ink as
 * `--trace-*` RGB channels for light and dark; this reads them off the root
 * element, and a painter asks for an ink at the alpha it draws with:
 * `ink.label(0.95)` is `rgba(148, 163, 184, 0.95)` on a dark page.
 *
 * Only the chart's furniture is here: surfaces, labels, axes, rules. The data
 * colours (thread states, queue ops, power states) mean the same thing in
 * either scheme and stay where they are defined.
 */

import { useSyncExternalStore } from 'react'

/** Each ink, by the custom property in index.css that holds its channels. */
const INK_VARS = {
  /** A selected lane's name: the text that has to stand out most. */
  strong: '--trace-strong',
  /** Titles, axis end labels, the playhead. */
  text: '--trace-text',
  /** The IPC depth chart's tick labels. */
  soft: '--trace-soft',
  /** Lane names, tick labels and marks, rules. */
  label: '--trace-label',
  /** Priorities and hints, quieter than a label. */
  dim: '--trace-dim',
  /** Lane troughs, section bands, row stripes. */
  shade: '--trace-shade',
  /** The IPC depth chart's own background. */
  backdrop: '--trace-backdrop',
  /** The glow that lifts a queue mark off the thread bar under it. */
  halo: '--trace-halo',
  /** The LIVE badge. */
  live: '--trace-live',
  /** A queue lane's name and depth. */
  queue: '--trace-queue',
  /** The same, on the lane under the pointer. */
  queueHot: '--trace-queue-hot',
  /** A queue lane's trough. */
  queueShade: '--trace-queue-shade',
  /** The IPC depth chart's line and transition dots. */
  depth: '--trace-depth',
} as const

export type TraceInk = Record<keyof typeof INK_VARS, (alpha: number) => string>

const LIGHT = '(prefers-color-scheme: light)'

function isLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia(LIGHT).matches
}

/**
 * `148 163 184` as `148, 163, 184`. An ink index.css does not declare (a test
 * without the stylesheet) comes out mid grey, which shows on either scheme.
 */
function channels(value: string): string {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean)
  return parts.length === 3 ? parts.join(', ') : '128, 128, 128'
}

function resolve(): TraceInk {
  const root =
    typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  return Object.fromEntries(
    Object.entries(INK_VARS).map(([name, prop]) => {
      const rgb = channels(root?.getPropertyValue(prop) ?? '')
      return [name, (alpha: number) => `rgba(${rgb}, ${alpha})`]
    }),
  ) as TraceInk
}

let cached: { light: boolean; ink: TraceInk } | null = null

/** The inks for the page's current scheme, read once per scheme. */
export function traceInk(): TraceInk {
  const light = isLight()
  if (cached?.light !== light) cached = { light, ink: resolve() }
  return cached.ink
}

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const mq = matchMedia(LIGHT)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/**
 * The inks, as a value that changes when the system switches between light and
 * dark. A chart lists it with the rest of its paint inputs, and so repaints.
 */
export function useTraceInk(): TraceInk {
  return useSyncExternalStore(subscribe, traceInk, traceInk)
}
