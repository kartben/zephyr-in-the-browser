import { describe, expect, it } from 'vitest'
import {
  fitGraphCamera,
  followGraphCamera,
  resizeGraphCamera,
  zoomGraphCamera,
  type GraphCamera,
  type GraphNodeBox,
} from './viewport'

const box = (id: string, x: number, y: number): GraphNodeBox => ({
  id,
  x,
  y,
  width: 20,
  height: 20,
})

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

  it('keeps the node nearest the middle in place when the graph is laid out again', () => {
    const viewport = { width: 400, height: 300 }
    // Zoomed in twice on b, whose center (60, 40) is in the middle of the view.
    const camera: GraphCamera = { x: 200 - 60 * 2, y: 150 - 40 * 2, scale: 2 }
    const before = [box('a', 0, 0), box('b', 50, 30), box('c', 200, 200)]
    // A route to a new node, d, moved everything; c went with a filter.
    const after = [box('a', 0, 100), box('b', 150, 130), box('d', 300, 0)]
    const next = followGraphCamera(camera, before, after, viewport)!

    expect(next.scale).toBe(2)
    // b's new center, (160, 140), is where the old one was on screen.
    expect(next.x + 160 * next.scale).toBe(200)
    expect(next.y + 140 * next.scale).toBe(150)
  })

  it('has nothing to follow when the layouts share no node', () => {
    const camera: GraphCamera = { x: 0, y: 0, scale: 1 }
    const viewport = { width: 100, height: 100 }
    expect(followGraphCamera(camera, [box('a', 0, 0)], [box('b', 0, 0)], viewport)).toBeNull()
  })
})
