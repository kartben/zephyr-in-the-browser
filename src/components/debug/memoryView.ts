/** Classic hexdump width. */
export const BYTES_PER_ROW = 16

/** Rows shown in the debugger memory pane. */
export const VISIBLE_ROWS = 16

/** Bytes fetched / shown per window (16 × 16). */
export const WINDOW_BYTES = BYTES_PER_ROW * VISIBLE_ROWS

/** Highest guest address we will place at the top of a full window. */
const MAX_TOP = 0x1_0000_0000 - WINDOW_BYTES

/**
 * Slide the memory window by whole rows. Clamps at 0 and the top of a
 * 32-bit address space so scroll never wraps.
 */
export function scrollMemoryAddr(addr: number, rowDelta: number): number {
  if (!Number.isFinite(addr) || !Number.isFinite(rowDelta)) return 0
  const aligned = Math.min(
    Math.floor(Math.max(0, addr) / BYTES_PER_ROW) * BYTES_PER_ROW,
    MAX_TOP,
  )
  const next = aligned + rowDelta * BYTES_PER_ROW
  if (next <= 0) return 0
  return Math.min(next, MAX_TOP)
}

/**
 * Translate a wheel event into whole-row steps. Line-mode deltas (mice) move
 * one row per notch; pixel-mode (trackpads) accumulate ~40px per row.
 */
export function wheelRowDelta(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) return 0
  if (deltaMode === 1) return Math.trunc(deltaY) || Math.sign(deltaY)
  if (deltaMode === 2) return Math.sign(deltaY) * VISIBLE_ROWS
  const rows = Math.round(deltaY / 40)
  return rows === 0 ? Math.sign(deltaY) : rows
}

/**
 * Window top for a PC seed: clear ARM Thumb LSB, then snap down to a row so
 * the hex gutter stays aligned and the instruction bytes are in view.
 */
export function pcWindowTop(pc: number, arch: 'arm' | 'aarch64' | 'riscv32' | null): number {
  let addr = pc >>> 0
  if (arch === 'arm') addr &= ~1
  return Math.floor(addr / BYTES_PER_ROW) * BYTES_PER_ROW
}

/**
 * How to move the visible window from `currentAddr` → `targetAddr` without
 * re-fetching bytes we already hold. Small wheel steps only need the new edge.
 */
export type WindowSlidePlan =
  | { kind: 'noop'; addr: number }
  | { kind: 'full'; addr: number; length: number }
  | {
      kind: 'forward'
      addr: number
      /** Drop this many leading bytes from the current buffer. */
      drop: number
      fetchAddr: number
      fetchLen: number
    }
  | {
      kind: 'backward'
      addr: number
      /** Keep this many trailing bytes from the current buffer. */
      keep: number
      fetchAddr: number
      fetchLen: number
    }

export function planWindowSlide(
  currentAddr: number,
  currentLen: number,
  targetAddr: number,
  windowLen = WINDOW_BYTES,
): WindowSlidePlan {
  const cur = currentAddr >>> 0
  const target = targetAddr >>> 0
  if (target === cur && currentLen === windowLen) return { kind: 'noop', addr: target }
  if (currentLen !== windowLen) return { kind: 'full', addr: target, length: windowLen }

  const delta = (target - cur) | 0 // signed distance; ok within 32-bit window slides
  if (delta > 0 && delta < windowLen) {
    return {
      kind: 'forward',
      addr: target,
      drop: delta,
      fetchAddr: (cur + windowLen) >>> 0,
      fetchLen: delta,
    }
  }
  if (delta < 0 && -delta < windowLen) {
    const fetchLen = -delta
    return {
      kind: 'backward',
      addr: target,
      keep: windowLen - fetchLen,
      fetchAddr: target,
      fetchLen,
    }
  }
  return { kind: 'full', addr: target, length: windowLen }
}

/** Build the next window from the previous buffer plus a freshly fetched edge. */
export function applyWindowSlide(
  current: Uint8Array,
  plan: Extract<WindowSlidePlan, { kind: 'forward' | 'backward' }>,
  fetched: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(current.length)
  if (plan.kind === 'forward') {
    // Drop leading bytes; append the new high edge.
    out.set(current.subarray(plan.drop), 0)
    out.set(fetched.subarray(0, plan.fetchLen), current.length - plan.fetchLen)
  } else {
    // Prefetch the new low edge; keep the leading overlap (not the tail).
    out.set(fetched.subarray(0, plan.fetchLen), 0)
    out.set(current.subarray(0, plan.keep), plan.fetchLen)
  }
  return out
}
