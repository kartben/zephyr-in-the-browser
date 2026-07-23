/**
 * A zperf/iperf2 peer: UDP + TCP sinks on port 5001 of any non-guest IP.
 *
 * Wire format per zephyr/subsys/net/lib/zperf/zperf_internal.h (modern,
 * non-legacy header): every UDP payload starts with
 *     struct zperf_udp_datagram { u32 id; u32 tv_sec; u32 tv_usec; u32 id2; }
 * big-endian, id negative (as int32) on the FIN datagram. The client then
 * blocks for a stats reply laid out as that 16-byte header echoed back,
 * followed by struct zperf_server_hdr (10 × u32 big-endian):
 *     flags(0x80000000=VERSION1) total_len1 total_len2 stop_sec stop_usec
 *     error_cnt outorder_cnt datagrams jitter1 jitter2
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
