import { describe, expect, it } from 'vitest'
import type { QueueGraphLayout } from './layout'
import { pickDirection } from './useFittedLayout'

/** Only a layout's size matters to the choice. */
const sized = (width: number, height: number) =>
  ({ width, height, nodes: [], edges: [], direction: 'RIGHT' }) as unknown as QueueGraphLayout

const dock = { width: 300, height: 360 }

describe('pickDirection', () => {
  // The sensor pipeline: wide when it runs across, closer to square when it runs down.
  const across = sized(1150, 400)
  const down = sized(710, 800)

  it('runs a wide pipeline downwards in the dock, where that draws it larger', () => {
    expect(pickDirection(null, across, down, dock)).toBe('DOWN')
  })

  it('keeps it running across in a wide window', () => {
    expect(pickDirection(null, across, down, { width: 1400, height: 420 })).toBe('RIGHT')
  })

  it('stays left to right when the graph fits either way', () => {
    expect(pickDirection(null, sized(400, 200), sized(200, 400), { width: 900, height: 900 })).toBe(
      'RIGHT',
    )
  })

  it('only turns for a clearly larger picture', () => {
    // Down is 10% larger here: not enough to turn, from either side.
    const right = sized(1000, 300)
    const slightly = sized(910, 300)
    const view = { width: 400, height: 1000 }
    expect(pickDirection('RIGHT', right, slightly, view)).toBe('RIGHT')
    expect(pickDirection('DOWN', right, slightly, view)).toBe('DOWN')
    expect(pickDirection('RIGHT', right, sized(700, 300), view)).toBe('DOWN')
  })
})
