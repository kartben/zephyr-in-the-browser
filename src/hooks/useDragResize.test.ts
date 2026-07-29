import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { clampBox, resizeBox } from '@/hooks/useDragResize'

describe('clampBox', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
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

describe('resizeBox', () => {
  const box = { x: 200, y: 150, w: 400, h: 300 }

  it('grows from the south-east without moving the origin', () => {
    expect(resizeBox(box, 'se', 50, 30)).toEqual({ x: 200, y: 150, w: 450, h: 330 })
  })

  it('moves the origin when pulling the north or west side', () => {
    expect(resizeBox(box, 'w', -60, 0)).toEqual({ x: 140, y: 150, w: 460, h: 300 })
    expect(resizeBox(box, 'n', 0, -40)).toEqual({ x: 200, y: 110, w: 400, h: 340 })
    expect(resizeBox(box, 'nw', 25, 25)).toEqual({ x: 225, y: 175, w: 375, h: 275 })
  })

  it('leaves the far edge put once a shrinking side hits its minimum', () => {
    // Dragging the west edge right by more than the box is wide: width stops at
    // MIN_W (192) and x stops with it, so the east edge never moves.
    const shrunk = resizeBox(box, 'w', 900, 0)
    expect(shrunk.w).toBe(192)
    expect(shrunk.x + shrunk.w).toBe(box.x + box.w)

    const flat = resizeBox(box, 'n', 900, 900)
    expect(flat.h).toBe(96) // MIN_H
    expect(flat.y + flat.h).toBe(box.y + box.h)
  })

  it('only touches the sides its edge names', () => {
    expect(resizeBox(box, 'e', 40, 999)).toEqual({ x: 200, y: 150, w: 440, h: 300 })
    expect(resizeBox(box, 's', 999, 40)).toEqual({ x: 200, y: 150, w: 400, h: 340 })
  })
})
