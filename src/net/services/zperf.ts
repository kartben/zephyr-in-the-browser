/**
 * zperf/iperf2 peer on port 5001. UDP FIN is a negative big-endian id; the
 * reply echoes the 16-byte datagram header plus 10 big-endian stats words.
 */

import { viewOf } from '../bytes'
import { NetStack } from '../stack'

export const ZPERF_PORT = 5001

interface UdpSession {
  datagrams: number
  bytes: number
  firstMs: number
  lastMs: number
  maxId: number
  outOfOrder: number
  lastReply: Uint8Array | null
}

export function installZperf(stack: NetStack): void {
  const sessions = new Map<string, UdpSession>()

  stack.udpListen({ port: ZPERF_PORT }, ({ srcIp, srcPort, dstIp, dstPort, payload }) => {
    if (payload.length < 4) return
    const id = viewOf(payload).getInt32(0)
    const key = `${srcIp}:${srcPort}`
    let session = sessions.get(key)

    if (id >= 0) {
      if (!session || (id <= 1 && session.lastReply)) {
        session = {
          datagrams: 0,
          bytes: 0,
          firstMs: stack.hooks.now(),
          lastMs: 0,
          maxId: 0,
          outOfOrder: 0,
          lastReply: null,
        }
        sessions.set(key, session)
        if (sessions.size > 8) sessions.delete(sessions.keys().next().value!)
      }
      session.datagrams += 1
      session.bytes += payload.length
      session.lastMs = stack.hooks.now()
      if (id < session.maxId) session.outOfOrder += 1
      else session.maxId = id
      return
    }

    // FIN: reply with the stats block (idempotent — retransmitted FINs get
    // the same report).
    if (!session) return
    if (!session.lastReply) session.lastReply = buildServerReport(session, payload)
    stack.sendUdpToGuest(dstIp, dstPort, srcIp, srcPort, session.lastReply)
  })

  // TCP upload: accept, count, discard; the client measures on its side.
  stack.tcp.listen({ port: ZPERF_PORT }, (socket) => {
    socket.handlers = {
      onData: () => {},
      onRemoteClose: (s) => s.close(),
    }
  })
}

function buildServerReport(session: UdpSession, finPayload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + 40)
  out.set(finPayload.subarray(0, Math.min(16, finPayload.length)), 0)
  const view = viewOf(out)
  const durationMs = Math.max(1, (session.lastMs || session.firstMs) - session.firstMs)
  const lost = Math.max(0, session.maxId - session.datagrams)

  view.setUint32(16, 0x80000000) // ZPERF_FLAGS_VERSION1
  view.setUint32(20, Math.floor(session.bytes / 2 ** 32))
  view.setUint32(24, session.bytes >>> 0)
  view.setUint32(28, Math.floor(durationMs / 1000))
  view.setUint32(32, Math.floor((durationMs % 1000) * 1000))
  view.setUint32(36, lost)
  view.setUint32(40, session.outOfOrder)
  view.setUint32(44, session.datagrams)
  view.setUint32(48, 0) // jitter1
  view.setUint32(52, 0) // jitter2
  return out
}
