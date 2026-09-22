import { describe, expect, it } from 'vitest'

import { createGpioEdgeRecorder } from './gpioEdges'

describe('gpio edge recorder', () => {
  it('keeps distinct words in order and drops repeats', () => {
    const r = createGpioEdgeRecorder(8)
    r.record(0b001)
    r.record(0b001)
    r.record(0b010)
    r.record(0b010)
    r.record(0b100)
    const { edges, dropped } = r.take()
    expect([...edges]).toEqual([0b001, 0b010, 0b100])
    expect(dropped).toBe(0)
  })

  it('records the first word even when it is zero', () => {
    // The model starts at zero, so "same as last" must not swallow the first
    // sample: a display resting dark is a state the latch has to see.
    const r = createGpioEdgeRecorder(4)
    r.record(0)
    expect([...r.take().edges]).toEqual([0])
  })

  it('starts a fresh batch after take', () => {
    const r = createGpioEdgeRecorder(8)
    r.record(1)
    r.take()
    expect(r.pending).toBe(false)
    r.record(2)
    expect([...r.take().edges]).toEqual([2])
  })

  it('does not re-record the last word of the previous batch', () => {
    const r = createGpioEdgeRecorder(8)
    r.record(1)
    r.take()
    r.record(1)
    expect([...r.take().edges]).toEqual([])
  })

  it('counts overflow instead of overwriting, and reports it', () => {
    const r = createGpioEdgeRecorder(2)
    r.record(1)
    r.record(2)
    r.record(3)
    r.record(4)
    const { edges, dropped } = r.take()
    // The retained prefix is intact; what was lost is counted, because a
    // partial multiplex replay is worse than none.
    expect([...edges]).toEqual([1, 2])
    expect(dropped).toBe(2)
  })

  it('survives a word with bit 31 set', () => {
    // The model builds words with `1 << line`, which is signed at line 31.
    const r = createGpioEdgeRecorder(4)
    r.record(1 << 31)
    r.record(1 << 31)
    const { edges } = r.take()
    expect([...edges]).toEqual([0x8000_0000])
  })

  it('reports pending only when there is something to send', () => {
    const r = createGpioEdgeRecorder(4)
    expect(r.pending).toBe(false)
    r.record(7)
    expect(r.pending).toBe(true)
    r.take()
    expect(r.pending).toBe(false)
  })

  it('forgets the last word on reset, so a rebind re-seeds', () => {
    const r = createGpioEdgeRecorder(4)
    r.record(5)
    r.take()
    r.reset()
    r.record(5)
    expect([...r.take().edges]).toEqual([5])
  })
})
