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
