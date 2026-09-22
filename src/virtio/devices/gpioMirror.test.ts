import { describe, expect, it, vi } from 'vitest'

import { createGpioModel } from './gpio'
import type { GpioBatch } from './gpioProtocol'

/**
 * The mirror half of the GPIO model: what the main thread runs while
 * `deviceWorker.ts` owns the virtqueues.
 *
 * The property that matters is that a *batch* of retained edges is
 * indistinguishable, to a subscriber, from the same edges delivered one at a
 * time. `src/hostSevenSeg.ts` and the SCT2024 both latch on the sequence, so if
 * batching collapsed it they would show wrong digits rather than late ones.
 */

function batch(over: Partial<GpioBatch> = {}): GpioBatch {
  return {
    edges: new Uint32Array(0),
    dropped: 0,
    inputs: 0,
    outputs: 0,
    ngpio: 8,
    directions: new Uint8Array(8),
    ...over,
  }
}

/** Record the output word a subscriber observes on each notification. */
function observed(apply: (model: ReturnType<typeof createGpioModel>) => void): number[] {
  const model = createGpioModel('gpio')
  model.setRemote(() => {})
  const seen: number[] = []
  model.subscribe(() => seen.push(model.getOutputs()))
  apply(model)
  return seen
}

describe('gpio mirror', () => {
  it('replays a multiplex batch edge for edge', () => {
    const edges = new Uint32Array([0x20, 0x21, 0x40, 0x46, 0x80, 0x81])
    const seen = observed((m) => m.applyBatch(batch({ edges, outputs: 0x81 })))
    expect(seen).toEqual([0x20, 0x21, 0x40, 0x46, 0x80, 0x81])
  })

  it('is indistinguishable from delivering the same edges one at a time', () => {
    // This is the regression the whole batching design has to survive.
    const edges = [0x20, 0x21, 0x40, 0x46, 0x80, 0x81, 0x20, 0x28]

    const batched = observed((m) =>
      m.applyBatch(batch({ edges: new Uint32Array(edges), outputs: edges.at(-1)! })),
    )
    const oneAtATime = observed((m) => {
      for (const word of edges) {
        m.applyBatch(batch({ edges: new Uint32Array([word]), outputs: word }))
      }
    })

    expect(batched).toEqual(oneAtATime)
    expect(batched).toEqual(edges)
  })

  it('resynchronises instead of replaying when edges were dropped', () => {
    // A partial multiplex replay latches a wrong digit and holds it. Jumping to
    // the endpoint is briefly wrong and then right, which is the better failure.
    const edges = new Uint32Array([0x20, 0x21, 0x40])
    const seen = observed((m) => m.applyBatch(batch({ edges, dropped: 5, outputs: 0x99 })))
    expect(seen).toEqual([0x99])
  })

  it('notifies even when a batch carries no edges', () => {
    // ngpio and direction arrive without any output moving, and the panel
    // renders off both.
    const seen = observed((m) => m.applyBatch(batch({ ngpio: 4 })))
    expect(seen).toHaveLength(1)
  })

  it('adopts ngpio, direction and the input word from the batch', () => {
    const model = createGpioModel('gpio')
    model.setRemote(() => {})
    model.applyBatch(
      batch({
        ngpio: 4,
        // 0 none, 1 out, 2 in.
        directions: Uint8Array.of(1, 2, 0, 1),
        inputs: 0b0010,
        outputs: 0b1001,
      }),
    )
    expect(model.ngpio).toBe(4)
    expect(model.getDirection(0)).toBe('out')
    expect(model.getDirection(1)).toBe('in')
    expect(model.getDirection(2)).toBe('none')
    expect(model.getInputs()).toBe(0b0010)
    expect(model.getOutputs()).toBe(0b1001)
  })

  it('forwards setInputs to the owner rather than firing interrupts locally', () => {
    const send = vi.fn()
    const model = createGpioModel('gpio')
    model.setRemote(send)
    model.applyBatch(batch({ ngpio: 8 }))

    model.setInputs(0b0100)
    expect(send).toHaveBeenCalledWith(0b0100)
    // Recorded locally so the panel reads back what it is driving.
    expect(model.getInputs()).toBe(0b0100)
  })

  it('does not forward an unchanged input word', () => {
    // hostGpio re-pushes its intended word on every model notification, which
    // during a replay is once per edge. That must not become worker traffic.
    const send = vi.fn()
    const model = createGpioModel('gpio')
    model.setRemote(send)
    model.setInputs(0b0001)
    model.setInputs(0b0001)
    model.setInputs(0b0001)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stops forwarding once the remote is cleared', () => {
    const send = vi.fn()
    const model = createGpioModel('gpio')
    model.setRemote(send)
    model.setRemote(null)
    model.attachConfig!(Uint8Array.of(8, 0, 0, 0, 0, 0, 0, 0), () => {})
    model.setInputs(0b0001)
    expect(send).not.toHaveBeenCalled()
    expect(model.getInputs()).toBe(0b0001)
  })
})
