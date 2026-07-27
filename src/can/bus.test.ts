import { describe, expect, it } from 'vitest'
import { createCanBus, frameBits, type CanFrame } from './bus'
import { nodeType } from './nodes'

/** Frames are short; a clock we drive by hand keeps the tests deterministic. */
function harness() {
  let t = 0
  const bus = createCanBus(() => t)
  return {
    bus,
    at: () => t,
    advance(ms: number) {
      t += ms
      bus.pump(t)
    },
  }
}

const frame = (id: number, data: number[] = [1, 2, 3, 4, 5, 6, 7, 8]): CanFrame => ({
  id,
  ext: false,
  rtr: false,
  data: Uint8Array.from(data),
})

describe('frameBits', () => {
  it('counts overhead, payload and intermission', () => {
    expect(frameBits(frame(0x100))).toBe(47 + 64 + 3)
    expect(frameBits({ ...frame(0x100), ext: true })).toBe(67 + 64 + 3)
    expect(frameBits({ id: 0x100, ext: false, rtr: true, data: new Uint8Array() })).toBe(50)
  })
})

describe('delivery', () => {
  it('offers a frame to every other node, never the sender', () => {
    const { bus, advance } = harness()
    const seen: Array<[string, number]> = []
    bus.attach({ id: 'a', name: 'A', receive: (f) => (seen.push(['a', f.id]), 'accepted') })
    bus.attach({ id: 'b', name: 'B', receive: (f) => (seen.push(['b', f.id]), 'accepted') })
    bus.attach({ id: 'c', name: 'C', receive: (f) => (seen.push(['c', f.id]), 'accepted') })

    bus.send('a', frame(0x100))
    advance(1)

    expect(seen).toEqual([
      ['b', 0x100],
      ['c', 0x100],
    ])
  })

  it('records the local node filtering an inbound frame', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'peer', name: 'Peer' })
    bus.attach({
      id: 'can0',
      name: 'can0',
      local: true,
      receive: (f) => (f.id === 0x100 ? 'accepted' : 'filtered'),
    })

    bus.send('peer', frame(0x100))
    bus.send('peer', frame(0x2ff))
    advance(5)

    const frames = bus.log().filter((e) => e.kind === 'frame')
    expect(frames.map((e) => [e.frame.id, e.drop])).toEqual([
      [0x100, undefined],
      [0x2ff, 'filtered'],
    ])
  })
})

describe('arbitration', () => {
  it('lowest id wins and the loser is logged once, then transmits', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'lo', name: 'Lo' })
    bus.attach({ id: 'hi', name: 'Hi' })
    bus.attach({ id: 'ack', name: 'Ack' })

    // The bus is idle, so this one goes out at once and occupies the medium.
    bus.send('ack', frame(0x000))
    // These two arrive while it is busy, so they contend when it frees.
    bus.send('hi', frame(0x200))
    bus.send('lo', frame(0x100))

    advance(10)

    const lost = () => bus.log().filter((e) => e.kind === 'arbitration')
    expect(lost()).toHaveLength(1)
    expect(lost()[0]).toMatchObject({ from: 'hi', lostTo: 0x100 })

    // Losing is a delay, not a drop — and re-arbitrating must not re-log.
    advance(10)
    expect(lost()).toHaveLength(1)
    const sent = bus.log().filter((e) => e.kind === 'frame')
    expect(sent.map((e) => e.frame.id)).toEqual([0x000, 0x100, 0x200])
  })

  it('does not arbitrate on an idle bus', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'a', name: 'A' })
    bus.attach({ id: 'b', name: 'B' })

    for (let i = 0; i < 5; i++) {
      bus.send('a', frame(0x100))
      advance(50)
    }

    expect(bus.log().filter((e) => e.kind === 'arbitration')).toHaveLength(0)
  })

  it('occupancy scales with bitrate, so a slow bus contends more', () => {
    const { bus, advance } = harness()
    bus.setBitrate(10_000)
    bus.attach({ id: 'a', name: 'A' })
    bus.attach({ id: 'b', name: 'B' })

    bus.send('a', frame(0x100))
    bus.send('b', frame(0x200))
    advance(1)

    // 114 bits at 10 kbit/s is 11.4 ms, so the second frame is still waiting.
    expect(bus.log().filter((e) => e.kind === 'frame')).toHaveLength(1)
    advance(20)
    expect(bus.log().filter((e) => e.kind === 'frame')).toHaveLength(2)
  })
})

describe('acknowledgement and error counters', () => {
  it('a good transmit walks TEC back down', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'peer', name: 'Peer' })

    bus.send('can0', frame(0x100))
    advance(5)

    expect(bus.nodes().find((n) => n.local)?.tec).toBe(0)
    expect(bus.log().some((e) => e.kind === 'no-ack')).toBe(false)
  })

  it('a listen-only node does not acknowledge', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'silent', name: 'Silent', acks: false })

    bus.send('can0', frame(0x100))
    advance(5)

    expect(bus.log()[0]).toMatchObject({ kind: 'no-ack', tec: 8 })
  })

  it('drives bus-off in 32 unacknowledged attempts, and latches there', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach({ id: 'peer', name: 'Peer' })

    bus.send('can0', frame(0x100))
    advance(5)
    expect(bus.nodes().find((n) => n.local)?.state).toBe('error-active')

    // Unplugging the last other node is the whole demo. The controller keeps
    // retransmitting on its own after that, so one more send is all it takes.
    bus.detach('peer')
    bus.send('can0', frame(0x100))
    for (let i = 0; i < 40; i++) advance(5)

    const local = () => bus.nodes().find((n) => n.local)!
    expect(local().state).toBe('bus-off')
    expect(local().tec).toBeGreaterThanOrEqual(256)

    const noAck = bus.log().filter((e) => e.kind === 'no-ack')
    expect(noAck).toHaveLength(32)
    expect(noAck.map((e) => e.tec)).toEqual(
      Array.from({ length: 32 }, (_, i) => (i + 1) * 8),
    )

    // Bus-off stops transmission entirely; it does not keep retrying.
    const before = bus.log().length
    advance(100)
    expect(bus.log()).toHaveLength(before)
  })

  it('passes through error-passive on the way', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })

    bus.send('can0', frame(0x100))
    for (let i = 0; i < 16; i++) advance(5)

    expect(bus.nodes()[0]!.state).toBe('error-passive')
  })

  it('recover clears the latch', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.send('can0', frame(0x100))
    for (let i = 0; i < 40; i++) advance(5)
    expect(bus.nodes()[0]!.state).toBe('bus-off')

    bus.recover('can0')
    expect(bus.nodes()[0]).toMatchObject({ state: 'error-active', tec: 0 })
  })

  it('loopback ACKs alone and never reaches other nodes', () => {
    const { bus, advance } = harness()
    const seen: number[] = []
    let peerHits = 0
    bus.attach({
      id: 'can0',
      name: 'can0',
      local: true,
      receive: (f) => {
        seen.push(f.id)
        return 'accepted'
      },
    })
    bus.attach({
      id: 'peer',
      name: 'peer',
      receive: () => {
        peerHits++
        return 'accepted'
      },
    })
    bus.setLoopback('can0', true)

    bus.send('can0', frame(0x100))
    advance(5)

    expect(bus.nodes().find((n) => n.id === 'can0')).toMatchObject({
      loopback: true,
      state: 'error-active',
      tec: 0,
    })
    expect(bus.nodes().find((n) => n.id === 'can0')!.summary).toContain('loopback')
    expect(bus.log().filter((e) => e.kind === 'frame')).toHaveLength(1)
    expect(bus.log().some((e) => e.kind === 'no-ack')).toBe(false)
    // Offered back to can0; peer never saw it.
    expect(seen).toEqual([0x100])
    expect(peerHits).toBe(0)
  })

  it('loopback keeps a lone controller off the bus-off path', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.setLoopback('can0', true)

    for (let i = 0; i < 40; i++) {
      bus.send('can0', frame(0x100))
      advance(5)
    }

    expect(bus.nodes()[0]!.state).toBe('error-active')
    expect(bus.log().some((e) => e.kind === 'no-ack')).toBe(false)
  })
})

describe('node presets', () => {
  it('babbling transmits on its own schedule', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach(nodeType('babbling')!.create('p', { id: 0x0a0, periodMs: 100 }))

    advance(50)
    expect(bus.log()).toHaveLength(0)
    advance(60)
    advance(100)

    const sent = bus.log().filter((e) => e.kind === 'frame')
    expect(sent).toHaveLength(2)
    expect(sent[0]!.frame.id).toBe(0x0a0)
    // Payload counts, so consecutive frames are distinguishable in the trace.
    expect(sent[0]!.frame.data[0]).toBe(0)
    expect(sent[1]!.frame.data[0]).toBe(1)
  })

  it('counter echoes any id with the first byte incremented', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach(nodeType('counter')!.create('c', { id: 0, periodMs: 0 }))

    bus.send('can0', frame(0x123, [7, 0, 0, 0, 0, 0, 0, 0]))
    advance(10)

    const reply = bus.log().filter((e) => e.kind === 'frame' && e.from === 'c')
    expect(reply).toHaveLength(1)
    expect(reply[0]!.frame.id).toBe(0x123)
    expect(reply[0]!.frame.data[0]).toBe(8)
  })

  it('responder answers RTR only', () => {
    const { bus, advance } = harness()
    bus.attach({ id: 'can0', name: 'can0', local: true })
    bus.attach(nodeType('responder')!.create('r', { id: 0x200, periodMs: 0 }))

    bus.send('can0', frame(0x200))
    advance(10)
    expect(bus.log().filter((e) => e.from === 'r')).toHaveLength(0)

    bus.send('can0', { id: 0x200, ext: false, rtr: true, data: new Uint8Array() })
    advance(10)
    expect(bus.log().filter((e) => e.from === 'r' && e.kind === 'frame')).toHaveLength(1)
  })

  it('silent is not listener: neither transmits, only one acknowledges', () => {
    const listener = nodeType('listener')!.create('l', { id: 0, periodMs: 0 })
    const silent = nodeType('silent')!.create('s', { id: 0, periodMs: 0 })
    expect(listener.transmit).toBeUndefined()
    expect(silent.transmit).toBeUndefined()
    expect(listener.acks).not.toBe(false)
    expect(silent.acks).toBe(false)
  })
})
