/** A TCP+UDP echo host at echo.internal (192.0.2.4:7), for echo-client-style
 * guests and stack self-tests. The bundled echo_server sample is the other
 * direction — the guest listens and the panel dials in via guestClient. */

import { NetStack } from '../stack'

export function installEchoHost(stack: NetStack): void {
  stack.tcp.listen({ port: 7, ip: stack.echoIp }, (socket) => {
    socket.handlers = {
      onData: (s, data) => s.send(data),
      onRemoteClose: (s) => s.close(),
    }
  })
  stack.udpListen({ port: 7, ip: stack.echoIp }, ({ srcIp, srcPort, dstIp, dstPort, payload }) => {
    stack.sendUdpToGuest(dstIp, dstPort, srcIp, srcPort, payload)
  })
}
