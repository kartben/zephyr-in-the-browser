import { describe, expect, it } from 'vitest'
import { createCanBus } from './bus'
import { nodeType } from './nodes'
import { createMcp2515, MCP2515_REGS as R } from '@/virtio/devices/chips/mcp2515'

/**
 * The seam, end to end: SPI bytes in one side, a peer's reply out the other.
 *
 * This is the path `samples/drivers/can/counter` actually takes, minus the
 * emulator — the chip turns register writes into a frame, the bus delivers it,
 * the Counter node answers, and the answer lands back in a receive buffer with
 * INT asserted. hostCan.ts is the only piece not exercised here, because its
 * job is exactly these two wires plus a GPIO pin.
 */

const OPTS = { csChange: true, bitsPerWord: 8, mode: 0, freq: 1_000_000 }
const CMD_READ = 0x03
const CMD_WRITE = 0x02
const CMD_RTS = 0x80

function harness() {
  let t = 0
  const bus = createCanBus(() => t)
  let int = false

  const chip = createMcp2515({
    onTransmit: (frame) => bus.send('can0', frame),
    onInt: (asserted) => {
      int = asserted
    },
  })

  bus.attach({
    id: 'can0',
    name: 'can0',
    local: true,
    receive: (frame) => chip.deliver(frame),
  })

  const write = (bytes: number[]) => {
    const tx = Uint8Array.from(bytes)
    chip.transfer(tx, new Uint8Array(tx.length), OPTS)
  }
  const read = (addr: number, len: number) => {
    const tx = new Uint8Array(2 + len)
    tx.set([CMD_READ, addr])
    const rx = new Uint8Array(tx.length)
    chip.transfer(tx, rx, OPTS)
    return rx.slice(2)
  }

  // Reset, leave configuration mode, enable the receive interrupts.
  write([0xc0])
  write([CMD_WRITE, R.CANCTRL, R.MODE_NORMAL << 5])
  write([CMD_WRITE, R.CANINTE, 0x03])

  return {
    bus,
    chip,
    write,
    read,
    int: () => int,
    advance(ms: number) {
      t += ms
      bus.pump(t)
    },
    /** Load TXB0 with a standard-id frame and request send. */
    transmit(id: number, data: number[]) {
      const sidh = (id >> 3) & 0xff
      const sidl = (id << 5) & 0xe0
      write([CMD_WRITE, R.TXB0 + 1, sidh, sidl, 0, 0, data.length, ...data])
      write([CMD_RTS | 0x01])
    },
  }
}

describe('mcp2515 on the bus', () => {
  it('counts with a Counter node, the way the sample does', () => {
    const h = harness()
    h.bus.attach(nodeType('counter')!.create('peer', { id: 0, periodMs: 0 }))

    h.transmit(0x123, [7, 0, 0, 0])
    h.advance(5)

    // The peer echoed with the first byte incremented, and it came back in.
    expect(h.read(R.RXB0 + 6, 4)[0]).toBe(8)
    expect(h.read(R.CANINTF, 1)[0]! & 0x01).toBe(0x01)
    expect(h.int()).toBe(true)

    // Ids survive the SIDH/SIDL round trip in both directions.
    const sidh = h.read(R.RXB0 + 1, 2)
    expect(((sidh[0]! << 3) | (sidh[1]! >> 5)) & 0x7ff).toBe(0x123)
  })

  it('a frame the filters reject is on the bus but not in a buffer', () => {
    const h = harness()
    h.bus.attach(nodeType('periodic')!.create('p', { id: 0x2ff, periodMs: 50 }))
    // Accept only 0x10x, on both buffers.
    h.write([CMD_WRITE, 0x20, 0xfe, 0x00])
    h.write([CMD_WRITE, 0x24, 0xfe, 0x00])
    h.write([CMD_WRITE, 0x00, 0x20, 0x00])

    h.advance(60)

    const entry = h.bus.log().find((e) => e.kind === 'frame')
    expect(entry).toMatchObject({ filtered: true })
    expect(h.read(R.CANINTF, 1)[0]! & 0x03).toBe(0)
    expect(h.int()).toBe(false)
  })

  it('with nobody to acknowledge, transmitting walks it to bus-off', () => {
    const h = harness()

    h.transmit(0x100, [1])
    for (let i = 0; i < 40; i++) h.advance(5)

    const local = h.bus.nodes().find((n) => n.local)!
    expect(local.state).toBe('bus-off')
    expect(h.bus.log().filter((e) => e.kind === 'no-ack')).toHaveLength(32)
  })

  it('a listen-only node is company that still leaves the bus dead', () => {
    const h = harness()
    h.bus.attach(nodeType('silent')!.create('s', { id: 0, periodMs: 0 }))

    h.transmit(0x100, [1])
    for (let i = 0; i < 40; i++) h.advance(5)

    // Two nodes on the roster, and still bus-off: listen-only sends no ACK.
    expect(h.bus.nodes()).toHaveLength(2)
    expect(h.bus.nodes().find((n) => n.local)!.state).toBe('bus-off')
  })

  it('a Listener keeps the same traffic healthy', () => {
    const h = harness()
    h.bus.attach(nodeType('listener')!.create('l', { id: 0, periodMs: 0 }))

    h.transmit(0x100, [1])
    for (let i = 0; i < 40; i++) h.advance(5)

    expect(h.bus.nodes().find((n) => n.local)!.state).toBe('error-active')
    expect(h.bus.log().filter((e) => e.kind === 'no-ack')).toHaveLength(0)
  })
})
