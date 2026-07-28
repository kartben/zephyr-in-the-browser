/**
 * Bottom stage overlays (Debug, Trace, Display) sit over the UART. The
 * terminal shrinks by this inset so the shell prompt stays clear of them.
 *
 * Cap keeps an expanded Trace from eating the whole stage — undock to float
 * if you need a taller card.
 */
export const STAGE_BOTTOM_OVERLAY_CAP = 0.42

/** Edge gap matching `bottom-3` / `md:bottom-4` on the stage stacks. */
export function stageOverlayEdgePx(minWidthMd = false): number {
  return minWidthMd ? 16 : 12
}

/**
 * Pixels to leave empty under the xterm host so docked bottom overlays do not
 * cover console output. `stackH` is the taller of the left/right stacks.
 */
export function stageBottomInset(stackH: number, stageH: number, edgePx: number): number {
  if (stackH <= 0 || stageH <= 0) return 0
  const raw = stackH + Math.max(0, edgePx)
  const cap = Math.floor(stageH * STAGE_BOTTOM_OVERLAY_CAP)
  return Math.min(raw, Math.max(0, cap))
}

/** Max height for a docked bottom stack so it stays inside the reserved band. */
export function stageOverlayStackMaxH(stageH: number, edgePx: number): number {
  if (stageH <= 0) return 0
  const budget = Math.floor(stageH * STAGE_BOTTOM_OVERLAY_CAP)
  return Math.max(0, budget - Math.max(0, edgePx))
}
