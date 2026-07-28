/**
 * Truncate a string so its rendered width fits `maxPx`, appending an ellipsis.
 * Uses canvas measureText with a monospace metric matching the graph labels.
 */

const FONT = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT_SM = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
const FONT_META = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace'

let canvas: HTMLCanvasElement | null = null

function fontSizePx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  return m ? Number(m[1]) : 10
}

function measure(text: string, font: string): number {
  const fallback = text.length * fontSizePx(font) * 0.62
  if (typeof document === 'undefined') return fallback
  try {
    if (!canvas) canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback
    ctx.font = font
    const w = ctx.measureText(text).width
    // jsdom / headless stubs often report 0 — fall back to the monospace heuristic.
    return w > 0 ? w : fallback
  } catch {
    return fallback
  }
}

export function fitEllipsis(text: string, maxPx: number, font = FONT_SM): string {
  if (maxPx <= 0 || !text) return ''
  if (measure(text, font) <= maxPx) return text
  const ell = '…'
  const ellW = measure(ell, font)
  if (ellW >= maxPx) return ell
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid), font) + ellW <= maxPx) lo = mid
    else hi = mid - 1
  }
  return lo <= 0 ? ell : `${text.slice(0, lo)}${ell}`
}

export const GRAPH_FONT = {
  pill: FONT_SM,
  tubeName: FONT,
  tubeMeta: FONT_META,
}
