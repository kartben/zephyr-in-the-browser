/**
 * Compact hex for debugger UI. Full-width padded values waste the popover;
 * tooltips keep the canonical form.
 */

/** Strip leading zeros; keep at least one digit. Input may omit `0x`. */
export function compactHex(hex: string | null | undefined): string {
  if (!hex) return ''
  const raw = hex.trim().replace(/^0x/i, '').toLowerCase()
  if (!raw) return '0'
  const trimmed = raw.replace(/^0+/, '')
  return trimmed || '0'
}

/** True when a GPR is unused / stack-paint — dimmed in the grid. */
export function isInactiveRegValue(hex: string): boolean {
  const v = hex.trim().toLowerCase().replace(/^0x/, '')
  if (!v) return true
  if (/^0+$/.test(v)) return true
  if (/^a+$/.test(v)) return true
  return false
}
