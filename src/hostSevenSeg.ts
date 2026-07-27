/**
 * Persistence-of-vision latch for `gpio-7-segment` multiplexing.
 *
 * Zephyr's driver lights one digit at a time (digit common on, segment bus
 * written, then next digit). The page only ever sees one commons-high frame,
 * so we capture the segment bus whenever a digit is selected and hold that
 * pattern until the next visit — matching what a real LED display looks like.
 *
 * Latch updates run synchronously on every GPIO output word (via
 * {@link subscribeOutputs}) so multiplex frames are not lost. React
 * subscribers are woken at most once per animation frame: a 1 ms refresh
 * period otherwise floods useSyncExternalStore and starves the console pty.
 */

import type { SevenSegDisplay, SevenSegPin } from '@/dts'
import {
  getSevenSegs,
  isOutputHigh,
  subscribeOutputs,
} from '@/hostGpio'

/** Bit0=A … bit6=G, bit7=DP — same packing as Zephyr's auxdisplay_gpio_7seg.c. */
export type SegmentMask = number

export interface SevenSegSnapshot {
  displays: Array<{
    id: string
    label: string
    columns: number
    /** Latched segment mask per digit (left → right). */
    digits: SegmentMask[]
    /** Which digit commons are currently driven (for a subtle “scan” cue). */
    active: boolean[]
  }>
}

const listeners = new Set<() => void>()
/** display id → latched masks */
const latched = new Map<string, SegmentMask[]>()
let uiNotifyRaf = 0

function logicalOn(pin: SevenSegPin): boolean {
  const physical = isOutputHigh(pin.id)
  return pin.activeHigh ? physical : !physical
}

function readSegments(disp: SevenSegDisplay): SegmentMask {
  let mask = 0
  for (let i = 0; i < disp.segments.length; i++) {
    const seg = disp.segments[i]!
    if (logicalOn(seg)) mask |= 1 << i
  }
  return mask
}

function ensureLatched(disp: SevenSegDisplay): SegmentMask[] {
  let masks = latched.get(disp.id)
  if (!masks || masks.length !== disp.digits.length) {
    masks = Array.from({ length: disp.digits.length }, () => 0)
    latched.set(disp.id, masks)
  }
  return masks
}

function sameSnapshot(a: SevenSegSnapshot, b: SevenSegSnapshot): boolean {
  if (a.displays.length !== b.displays.length) return false
  for (let i = 0; i < a.displays.length; i++) {
    const da = a.displays[i]!
    const db = b.displays[i]!
    if (da.id !== db.id || da.columns !== db.columns) return false
    if (da.digits.length !== db.digits.length || da.active.length !== db.active.length) {
      return false
    }
    for (let d = 0; d < da.digits.length; d++) {
      if (da.digits[d] !== db.digits[d] || da.active[d] !== db.active[d]) return false
    }
  }
  return true
}

function recompute(): SevenSegSnapshot {
  const displays = getSevenSegs()
  const live = new Set(displays.map((d) => d.id))
  for (const id of [...latched.keys()]) {
    if (!live.has(id)) latched.delete(id)
  }

  return {
    displays: displays.map((disp) => {
      const masks = ensureLatched(disp)
      const active = disp.digits.map((d) => logicalOn(d))
      for (let i = 0; i < disp.digits.length; i++) {
        if (active[i]) masks[i] = readSegments(disp)
      }
      return {
        id: disp.id,
        label: disp.label,
        columns: disp.columns,
        digits: masks.slice(),
        active: active.slice(),
      }
    }),
  }
}

let snapshot = recompute()

function onOutputs() {
  const next = recompute()
  if (sameSnapshot(snapshot, next)) return
  snapshot = next
  if (uiNotifyRaf !== 0) return
  uiNotifyRaf = requestAnimationFrame(() => {
    uiNotifyRaf = 0
    for (const fn of listeners) fn()
  })
}

subscribeOutputs(onOutputs)

export function getSnapshot(): SevenSegSnapshot {
  return snapshot
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test helper: force a recompute after mocking GPIO levels. */
export function refreshForTest(): void {
  snapshot = recompute()
  for (const fn of listeners) fn()
}
