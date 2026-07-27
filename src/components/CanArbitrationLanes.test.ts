import { describe, expect, it } from 'vitest'
import { createCanBus } from '@/can/bus'
import { buildLaneModel } from './CanArbitrationLanes'

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

    const model = buildLaneModel(bus.nodes(), bus.log(), t, 2000)

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

  it('drops ticks outside the sliding window', () => {
    let t = 0
    const bus = createCanBus(() => t)
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'ack', name: 'Ack' })
    bus.send('ack', frame(0x0a0, [1]))
    t += 5
    bus.pump(t)

    expect(buildLaneModel(bus.nodes(), bus.log(), t, 2000).ticks.length).toBeGreaterThan(0)
    expect(buildLaneModel(bus.nodes(), bus.log(), t + 5000, 2000).ticks).toHaveLength(0)
  })
})
