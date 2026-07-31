import { describe, expect, it } from 'vitest'
import { corruptPacket, FakeRspServer } from '@/debug/gdb/testing/fakeRspServer'
import { encodePacket } from '@/debug/gdb/rspCodec'

const text = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!)
  return out
}

describe('FakeRspServer', () => {
  it('acks incoming packets and counts unacked replies in ack mode', () => {
    const server = new FakeRspServer()
    const t = server.transport()
    t.send(encodePacket('?'))
    // Server acks our packet, then replies with the halt reason.
    expect(text(t.drain())).toBe(`+${encodePacket('T05thread:01;')}`)
    // Moving on without acking is tolerated but counted.
    t.send(encodePacket('g'))
    expect(server.missingAcks).toBe(1)
    // Acking properly keeps the count still.
    t.send('+')
    t.send(encodePacket('?'))
    expect(server.missingAcks).toBe(1)
  })

  it('retransmits on a nack and drops ack bookkeeping after no-ack mode', () => {
    const server = new FakeRspServer()
    const t = server.transport()
    t.send(corruptPacket('?'))
    expect(server.retransmits).toBe(1)
    t.send(encodePacket('QStartNoAckMode'))
    t.send('+')
    expect(server.noAck).toBe(true)
    t.drain()
    t.send(encodePacket('?'))
    // No server ack in no-ack mode: the reply comes bare.
    expect(text(t.drain())).toBe(encodePacket('T05thread:01;'))
    // A corrupt inbound packet produces no reply, so nothing was left unacked.
    expect(server.missingAcks).toBe(0)
  })

  it('answers ? with S00 while the adopted target is running', () => {
    const server = new FakeRspServer({ startRunning: true })
    const t = server.transport()
    t.send(encodePacket('?'))
    expect(text(t.drain())).toContain('$S00#')
    // A break then halts it with a real stop reply.
    t.send('\x03')
    expect(server.breaks).toBe(1)
    expect(text(t.drain())).toContain('T02')
  })

  it('discards a break to a halted target in silence', () => {
    const server = new FakeRspServer()
    const t = server.transport()
    t.send('\x03')
    expect(server.discardedBreaks).toBe(1)
    expect(t.drain().length).toBe(0)
  })

  it('rejects vCont without support and Z0 in flash', () => {
    const server = new FakeRspServer({
      supportsVCont: false,
      flashRange: { start: 0x0800_0000, end: 0x0810_0000 },
    })
    const t = server.transport()
    t.send(encodePacket('vCont?'))
    expect(text(t.drain())).toContain('$#00')
    t.send(encodePacket('vCont;c'))
    expect(server.running).toBe(false)
    t.drain()
    t.send(encodePacket('Z0,8000100,2'))
    expect(text(t.drain())).toContain('E01')
    t.send(encodePacket('Z1,8000100,2'))
    expect(text(t.drain())).toContain('OK')
    expect(server.hwBreakpoints.has(0x8000100)).toBe(true)
  })
})
