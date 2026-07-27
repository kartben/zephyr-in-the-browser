/**
 * Persistence-of-vision latch for `gpio-7-segment` multiplexing.
 *
 * Zephyr's driver lights one digit at a time (digit common on, segment bus
 * written, then next digit). The page only ever sees one commons-high frame,
 * so we capture the segment bus whenever a digit is selected and hold that
 * pattern until the next visit — matching what a real LED display looks like.
 */

import type { SevenSegDisplay, SevenSegPin } from '@/dts'
import {
  getSevenSegs,
  isOutputHigh,
  subscribe as subscribeGpio,
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

function notify() {
  snapshot = recompute()
  for (const fn of listeners) fn()
}

subscribeGpio(notify)

export function getSnapshot(): SevenSegSnapshot {
  return snapshot
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Test helper: force a recompute after mocking GPIO levels. */
export function refreshForTest(): void {
  notify()
}
