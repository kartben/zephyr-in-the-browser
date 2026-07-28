import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { clampBox } from '@/hooks/useDragResize'

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

  it('sizeOnly keeps x/y and still enforces min width/height', () => {
    expect(clampBox({ x: -20, y: 50, w: 100, h: 50 }, { sizeOnly: true })).toEqual({
      x: -20,
      y: 50,
      w: 192,
      h: 96,
    })
  })

  it('sizeOnly caps width to the viewport', () => {
    expect(clampBox({ x: 0, y: 0, w: 2000, h: 400 }, { sizeOnly: true }).w).toBe(1000 - 32)
  })
})
