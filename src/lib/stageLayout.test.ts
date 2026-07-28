import { describe, expect, it } from 'vitest'
import {
  STAGE_BOTTOM_OVERLAY_CAP,
  stageBottomInset,
  stageOverlayEdgePx,
  stageOverlayStackMaxH,
} from './stageLayout'

describe('stageBottomInset', () => {
  it('returns 0 when nothing is stacked', () => {
    expect(stageBottomInset(0, 800, 16)).toBe(0)
  })

  it('reserves stack height plus the bottom edge gap', () => {
    expect(stageBottomInset(120, 800, 16)).toBe(136)
  })

  it('caps tall overlays so the UART keeps most of the stage', () => {
    const stageH = 1000
    const cap = Math.floor(stageH * STAGE_BOTTOM_OVERLAY_CAP)
    expect(stageBottomInset(900, stageH, 16)).toBe(cap)
  })
})

describe('stageOverlayStackMaxH', () => {
  it('fits the stack inside the reserved band under the edge gap', () => {
    expect(stageOverlayStackMaxH(1000, 16)).toBe(Math.floor(1000 * STAGE_BOTTOM_OVERLAY_CAP) - 16)
  })
})

describe('stageOverlayEdgePx', () => {
  it('matches Tailwind bottom-3 / md:bottom-4', () => {
    expect(stageOverlayEdgePx(false)).toBe(12)
    expect(stageOverlayEdgePx(true)).toBe(16)
  })
})
