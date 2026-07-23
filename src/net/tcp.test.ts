import { describe, expect, it } from 'vitest'
import { TcpEngine, type TcpEmit, type TcpSocket } from './tcp'
import { TCP_ACK, TCP_SYN } from './tcpWire'
import { seededRandom } from './testing/loopback'

/**
 * Two engines wired segment-to-segment (no IP layer), with a virtual clock
 * and per-direction drop counters for retransmission tests.
 */
function createPair() {
  let nowMs = 0
  const random = seededRandom(7)
  const emitted: { a: TcpEmit[]; b: TcpEmit[] } = { a: [], b: [] }
  const drops = { a: 0, b: 0 }

  const pending: Array<() => void> = []
  let pumping = false
  const enqueue = (fn: () => void) => {
    pending.push(fn)
    if (pumping) return
    pumping = true
    while (pending.length > 0) pending.shift()!()
    pumping = false
  }

  const engineA: TcpEngine = new TcpEngine({
    emit: (out) => {
      emitted.a.push(out)
      if (drops.a > 0) {
        drops.a -= 1
        return
      }
      enqueue(() => engineB.onSegment(out.src.ip, out.dst.ip, out.seg))
    },
    now: () => nowMs,
    randomSeq: () => Math.floor(random() * 0xffffffff),
  })
  const engineB: TcpEngine = new TcpEngine({
    emit: (out) => {
      emitted.b.push(out)
      if (drops.b > 0) {
        drops.b -= 1
        return
      }
      enqueue(() => engineA.onSegment(out.src.ip, out.dst.ip, out.seg))
    },
    now: () => nowMs,
    randomSeq: () => Math.floor(random() * 0xffffffff),
  })

  return {
    engineA,
    engineB,
    emitted,
    drops,
    advance(ms: number) {
      for (let left = ms; left > 0; left -= 50) {
        nowMs += Math.min(50, left)
        engineA.tick()
        engineB.tick()
      }
    },
  }
}

const A = { ip: 0x0a000001, port: 1000 }
const B = { ip: 0x0a000002, port: 2000 }
const text = (s: string) => new TextEncoder().encode(s)
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b)

describe('TcpEngine', () => {
  it('opens, exchanges data both ways, and closes gracefully', () => {
    const pair = createPair()
    const serverReceived: string[] = []
    const clientReceived: string[] = []
    let serverSocket: TcpSocket | null = null
    let opened = 0
    let closed = 0

    pair.engineB.listen({ port: B.port }, (socket) => {
      serverSocket = socket
      socket.handlers = {
        onOpen: () => opened++,
        onData: (s, d) => {
          serverReceived.push(utf8(d))
          s.send(text('pong:' + utf8(d)))
        },
        onRemoteClose: (s) => s.close(),
        onClose: () => closed++,
      }
    })

    const client = pair.engineA.connect(A, B, {
      onOpen: () => opened++,
      onData: (_s, d) => clientReceived.push(utf8(d)),
      onClose: () => closed++,
    })

    expect(opened).toBe(2)
    client.send(text('hello'))
    expect(serverReceived).toEqual(['hello'])
    expect(clientReceived).toEqual(['pong:hello'])

    client.close()
    pair.advance(1000) // let TIME_WAIT expire
    expect(closed).toBe(2)
    expect(pair.engineA.connectionCount()).toBe(0)
    expect(pair.engineB.connectionCount()).toBe(0)
    expect(serverSocket).not.toBeNull()
  })

  it('produces a well-formed SYN / SYN-ACK exchange (golden-ish)', () => {
    const pair = createPair()
    pair.engineB.listen({ port: B.port }, (socket) => {
      socket.handlers = {}
    })
    pair.engineA.connect(A, B, {})

    const syn = pair.emitted.a[0].seg
    expect(syn.flags).toBe(TCP_SYN)
    expect(syn.mss).toBe(1460)
    expect(syn.window).toBe(65535)
    expect(syn.ack).toBe(0)

    const synAck = pair.emitted.b[0].seg
    expect(synAck.flags).toBe(TCP_SYN | TCP_ACK)
    expect(synAck.ack).toBe((syn.seq + 1) >>> 0)
    expect(synAck.mss).toBe(1460)

    const ack = pair.emitted.a[1].seg
    expect(ack.flags).toBe(TCP_ACK)
    expect(ack.seq).toBe((syn.seq + 1) >>> 0)
    expect(ack.ack).toBe((synAck.seq + 1) >>> 0)
  })

  it('segments large sends to MSS and reassembles in order', () => {
    const pair = createPair()
    const received: number[] = []
    pair.engineB.listen({ port: B.port }, (socket) => {
      socket.handlers = { onData: (_s, d) => received.push(d.length) }
    })
    const client = pair.engineA.connect(A, B, {})
    const big = new Uint8Array(4000).fill(0x42)
    client.send(big)
    expect(received.reduce((a, b) => a + b, 0)).toBe(4000)
    expect(Math.max(...received)).toBeLessThanOrEqual(1460)
  })

  it('answers a SYN to a closed port with false (caller RSTs)', () => {
    const pair = createPair()
    const handled = pair.engineB.onSegment(A.ip, B.ip, {
      srcPort: A.port,
      dstPort: 9999,
      seq: 100,
      ack: 0,
      flags: TCP_SYN,
      window: 65535,
      payload: new Uint8Array(0),
      mss: 1460,
    })
    expect(handled).toBe(false)
  })

  it('retransmits dropped data and recovers', () => {
    const pair = createPair()
    const received: string[] = []
    pair.engineB.listen({ port: B.port }, (socket) => {
      socket.handlers = { onData: (_s, d) => received.push(utf8(d)) }
    })
    const client = pair.engineA.connect(A, B, {})

    pair.drops.a = 1 // lose the next segment from A
    client.send(text('lost-then-found'))
    expect(received).toEqual([])

    pair.advance(600) // beyond the 500 ms RTO
    expect(received).toEqual(['lost-then-found'])
  })

  it('gives up after retries and resets', () => {
    const pair = createPair()
    let reset = false
    pair.engineB.listen({ port: B.port }, (socket) => {
      socket.handlers = {}
    })
    const client = pair.engineA.connect(A, B, { onReset: () => (reset = true) })

    pair.drops.a = 100 // black-hole everything from A
    client.send(text('into the void'))
    pair.advance(10_000)
    expect(reset).toBe(true)
    expect(pair.engineA.connectionCount()).toBe(0)
  })

  it('trims duplicate data after a lost ACK', () => {
    const pair = createPair()
    const received: string[] = []
    pair.engineB.listen({ port: B.port }, (socket) => {
      socket.handlers = { onData: (_s, d) => received.push(utf8(d)) }
    })
    const client = pair.engineA.connect(A, B, {})

    pair.drops.b = 1 // the ACK for the first data segment vanishes
    client.send(text('once'))
    expect(received).toEqual(['once'])
    pair.advance(600) // A retransmits; B must not re-deliver
    expect(received).toEqual(['once'])
    client.send(text('twice'))
    expect(received).toEqual(['once', 'twice'])
  })
})
