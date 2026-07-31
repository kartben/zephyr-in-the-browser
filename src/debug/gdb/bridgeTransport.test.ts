import { describe, expect, it } from 'vitest'
import { bridgeRspTransport, type BridgeGdbIo } from '@/debug/gdb/bridgeTransport'

/** Scripted io: captures the registered handler and every outgoing byte. */
function fakeIo() {
  let handler: ((payload: Uint8Array) => void) | null = null
  const sent: Uint8Array[] = []
  const io: BridgeGdbIo = {
    sendGdbBytes: (bytes) => {
      sent.push(bytes.slice())
      return true
    },
    setGdbHandler: (h) => {
      handler = h
    },
  }
  return { io, sent, deliver: (bytes: Uint8Array) => handler?.(bytes), hasHandler: () => handler !== null }
}

describe('bridgeRspTransport', () => {
  it('buffers frames across deliveries and drains them once', () => {
    const { io, deliver } = fakeIo()
    const transport = bridgeRspTransport(io)
    deliver(new Uint8Array([0x2b]))
    deliver(new Uint8Array([0x24, 0x4f, 0x4b]))
    expect([...transport.drain()]).toEqual([0x2b, 0x24, 0x4f, 0x4b])
    expect(transport.drain().length).toBe(0)
  })

  it('encodes outgoing text byte-for-char like the chardev path', () => {
    const { io, sent } = fakeIo()
    const transport = bridgeRspTransport(io)
    transport.send('$?#3f')
    transport.send('\x03')
    expect(sent.map((b) => [...b])).toEqual([[0x24, 0x3f, 0x23, 0x33, 0x66], [0x03]])
  })

  it('wakes the session owner when bytes arrive', () => {
    const { io, deliver } = fakeIo()
    const transport = bridgeRspTransport(io)
    let wakes = 0
    transport.setOnData?.(() => wakes++)
    deliver(new Uint8Array([0x2b]))
    deliver(new Uint8Array([0x2d]))
    expect(wakes).toBe(2)
  })

  it('close releases the channel and drops buffered bytes', () => {
    const { io, deliver, hasHandler } = fakeIo()
    const transport = bridgeRspTransport(io)
    deliver(new Uint8Array([1, 2, 3]))
    transport.close?.()
    expect(hasHandler()).toBe(false)
    expect(transport.drain().length).toBe(0)
  })

  it('a new transport claims the channel from the old one', () => {
    const { io, deliver } = fakeIo()
    const first = bridgeRspTransport(io)
    deliver(new Uint8Array([9, 9]))
    const second = bridgeRspTransport(io)
    // Frames buffered by the first session die with it; the new one is empty.
    expect(second.drain().length).toBe(0)
    deliver(new Uint8Array([1]))
    expect([...second.drain()]).toEqual([1])
    expect([...first.drain()]).toEqual([9, 9])
  })
})
