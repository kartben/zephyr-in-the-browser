import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { clampBox } from '@/hooks/useDragResize'

describe('clampBox', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 800)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a full-height box inside the viewport', () => {
    expect(clampBox({ x: 900, y: 700, w: 300, h: 400 })).toEqual({
      x: 700,
      y: 400,
      w: 300,
      h: 400,
    })
  })

  it('clamps Y against visibleHeight so a collapsed header can sit lower', () => {
    const box = clampBox({ x: 100, y: 900, w: 300, h: 400 }, { visibleHeight: 40 })
    expect(box.h).toBe(400) // stored height preserved
    expect(box.y).toBe(760) // 800 - 40
  })
})
