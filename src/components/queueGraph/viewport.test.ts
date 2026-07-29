import { describe, expect, it } from 'vitest'
import {
  fitGraphCamera,
  resizeGraphCamera,
  zoomGraphCamera,
  type GraphCamera,
} from './viewport'

describe('queue graph viewport', () => {
  it('fits the entire graph with padding without enlarging small layouts', () => {
    expect(fitGraphCamera({ width: 1000, height: 500 }, { width: 500, height: 300 })).toEqual({
      x: 28,
      y: 39,
      scale: 0.444,
    })
    expect(fitGraphCamera({ width: 100, height: 80 }, { width: 500, height: 300 }).scale).toBe(1)
  })

  it('zooms around the pointer, keeping its world position fixed', () => {
    const camera: GraphCamera = { x: 20, y: 30, scale: 1 }
    const next = zoomGraphCamera(camera, 2, { x: 120, y: 80 }, 0.25, 4)

    expect(next).toEqual({ x: -80, y: -20, scale: 2 })
    expect((120 - next.x) / next.scale).toBe((120 - camera.x) / camera.scale)
    expect((80 - next.y) / next.scale).toBe((80 - camera.y) / camera.scale)
  })

  it('clamps zoom without shifting the selected world point', () => {
    const next = zoomGraphCamera(
      { x: 0, y: 0, scale: 1 },
      100,
      { x: 50, y: 50 },
      0.5,
      2,
    )
    expect(next).toEqual({ x: -50, y: -50, scale: 2 })
  })

  it('reveals more space on resize while preserving scale and center', () => {
    const next = resizeGraphCamera(
      { x: 10, y: 20, scale: 0.75 },
      { width: 400, height: 300 },
      { width: 600, height: 340 },
    )
    expect(next).toEqual({ x: 110, y: 40, scale: 0.75 })
  })
})
