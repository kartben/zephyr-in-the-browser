import { describe, expect, it } from 'vitest'
import { createCanBus, type CanLogEntry } from '@/can/bus'
import {
  buildLaneModel,
  clampLaneView,
  livePinnedView,
  panDeltaMs,
} from './CanArbitrationLanes'

const frame = (id: number, data: number[] = []) => ({
  id,
  ext: false,
  rtr: false,
  data: Uint8Array.from(data),
})

describe('buildLaneModel', () => {
  it('places a hollow tick on the loser and a hop to its retry', () => {
    let t = 1000
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'hi', name: 'Hi' })
    bus.attach({ id: 'ack', name: 'Ack' })

    // Occupy the medium, then contend when it frees.
    bus.send('ack', frame(0x000))
    bus.send('hi', frame(0x200))
    bus.send('can0', frame(0x100))
    t += 10
    bus.pump(t)
    t += 10
    bus.pump(t)

    const model = buildLaneModel(bus.nodes(), bus.log(), livePinnedView(t, 2000))

    expect(model.lanes.map((l) => l.id)).toEqual(['can0', 'hi', 'ack'])
    const lost = model.ticks.filter((tick) => tick.lost)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatchObject({ nodeId: 'hi', frameId: 0x200, lostTo: 0x100 })
    expect(model.hops).toHaveLength(1)
    expect(model.hops[0]).toMatchObject({
      nodeId: 'hi',
      winnerNodeId: 'can0',
    })
    expect(model.hops[0]!.retryAt).toBeGreaterThan(model.hops[0]!.lostAt)
  })

  it('drops ticks outside the view window', () => {
    let t = 0
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'ack', name: 'Ack' })
    bus.send('ack', frame(0x0a0, [1]))
    t += 5
    bus.pump(t)

    expect(buildLaneModel(bus.nodes(), bus.log(), livePinnedView(t, 2000)).ticks.length).toBeGreaterThan(
      0,
    )
    expect(
      buildLaneModel(bus.nodes(), bus.log(), livePinnedView(t + 5000, 2000)).ticks,
    ).toHaveLength(0)
  })
})

describe('clampLaneView', () => {
  const entry = (at: number, seq: number): CanLogEntry => ({
    seq,
    at,
    kind: 'frame',
    from: 'a',
    local: false,
    frame: frame(0x100),
  })

  it('keeps a panned window inside the log span', () => {
    const log = [entry(100, 0), entry(500, 1), entry(900, 2)]
    expect(clampLaneView(log, 0, 200)).toEqual({ t0: 100, t1: 300 })
    expect(clampLaneView(log, 800, 1000)).toEqual({ t0: 700, t1: 900 })
  })

  it('collapses to the full span when the window is wider than the log', () => {
    const log = [entry(100, 0), entry(150, 1)]
    expect(clampLaneView(log, 0, 2000)).toEqual({ t0: 100, t1: 150 })
  })
})

describe('panDeltaMs', () => {
  it('maps a leftward drag to a later window', () => {
    // Dragging left (negative dx) reveals later time — same as TracePanel.
    expect(panDeltaMs(-50, 100, { t0: 0, t1: 200 })).toBe(100)
  })
})
