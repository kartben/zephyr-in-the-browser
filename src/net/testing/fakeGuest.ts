/**
 * A scripted guest for tests and the mock backend: it speaks through the
 * same codecs and the same TcpEngine as the page-side stack, so demo mode
 * and the vitest suite exercise the real implementation end to end (golden
 * byte-vector tests elsewhere guard against self-play blindness).
 */

import { ipFromString, macFromString, MAC_BROADCAST, viewOf } from '../bytes'
import { ARP_REPLY, ARP_REQUEST, buildArp, parseArp } from '../arp'
import { buildEth, parseEth, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from '../ethernet'
import { buildEchoReply, buildIcmp, parseIcmp, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST } from '../icmp'
import { buildIpv4, parseIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from '../ipv4'
import { buildUdp, parseUdp } from '../udp'
import { parseDhcp, DHCP_ACK, DHCP_CLIENT_PORT, DHCP_OFFER, DHCP_SERVER_PORT } from '../dhcp'
import { DNS_TYPE_A } from '../dns'
import { buildTcpSegment, parseTcpSegment } from '../tcpWire'
import { rstReplyFor, TcpEngine, type TcpEmit, type TcpSocket } from '../tcp'

export interface FakeGuestHooks {
  sendFrame(frame: Uint8Array): void
  now(): number
  random(): number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class FakeGuest {
  readonly mac: Uint8Array
  ip = 0
  dnsServer = ipFromString('192.0.2.3')!
  private hooks: FakeGuestHooks
  readonly tcp: TcpEngine
  private udpHandlers: Array<{ port: number; handler: (src: { ip: number; port: number }, payload: Uint8Array) => void }> = []
  private dhcpResolve: ((ip: number) => void) | null = null
  private pingWaiters = new Map<number, () => void>()
  private ephemeral = 40000
  private xid = 0x5a5a0000

  constructor(hooks: FakeGuestHooks, mac = 'aa:c0:ff:ee:00:01') {
    this.hooks = hooks
    this.mac = macFromString(mac)!
    this.tcp = new TcpEngine({
      emit: (out) => this.emitTcp(out),
      now: () => hooks.now(),
      randomSeq: () => Math.floor(hooks.random() * 0xffffffff) >>> 0,
    })
  }

  /* --------------------------------------------------------------- wire */

  onFrame(frame: Uint8Array): void {
    const eth = parseEth(frame)
    if (!eth) return

    if (eth.etherType === ETHERTYPE_ARP) {
      const arp = parseArp(eth.payload)
      if (arp?.op === ARP_REQUEST && arp.targetIp === this.ip && this.ip !== 0) {
        this.hooks.sendFrame(
          buildEth(
            arp.senderMac,
            this.mac,
            ETHERTYPE_ARP,
            buildArp({ op: ARP_REPLY, senderMac: this.mac, senderIp: this.ip, targetMac: arp.senderMac, targetIp: arp.senderIp }),
          ),
        )
      }
      return
    }
    if (eth.etherType !== ETHERTYPE_IPV4) return
    const ip = parseIpv4(eth.payload)
    if (!ip) return

    if (ip.proto === IPPROTO_ICMP) {
      const icmp = parseIcmp(ip.payload)
      if (!icmp) return
      if (icmp.type === ICMP_ECHO_REQUEST) {
        this.sendIpv4(ip.dst, ip.src, IPPROTO_ICMP, buildEchoReply(icmp))
      } else if (icmp.type === ICMP_ECHO_REPLY) {
        this.pingWaiters.get(icmp.seq)?.()
        this.pingWaiters.delete(icmp.seq)
      }
      return
    }

    if (ip.proto === IPPROTO_UDP) {
      const udp = parseUdp(ip.payload)
      if (!udp) return
      if (udp.dstPort === DHCP_CLIENT_PORT) {
        this.onDhcpReply(udp.payload)
        return
      }
      this.udpHandlers.find((h) => h.port === udp.dstPort)?.handler({ ip: ip.src, port: udp.srcPort }, udp.payload)
      return
    }

    if (ip.proto === IPPROTO_TCP) {
      const seg = parseTcpSegment(ip.payload)
      if (!seg) return
      if (!this.tcp.onSegment(ip.src, ip.dst, seg)) {
        const rst = rstReplyFor(seg)
        this.sendIpv4(ip.dst, ip.src, IPPROTO_TCP, buildTcpSegment(ip.dst, ip.src, rst))
      }
    }
  }

  tick(): void {
    this.tcp.tick()
  }

  /* ------------------------------------------------------------ actions */

  /** Static configuration, announced with a gratuitous ARP like Zephyr does. */
  configureStatic(ip: string): void {
    this.ip = ipFromString(ip)!
    this.hooks.sendFrame(
      buildEth(
        MAC_BROADCAST,
        this.mac,
        ETHERTYPE_ARP,
        buildArp({ op: ARP_REQUEST, senderMac: this.mac, senderIp: this.ip, targetMac: new Uint8Array(6), targetIp: this.ip }),
      ),
    )
  }

  /** Run the DHCP handshake; resolves with the bound address. */
  dhcp(): Promise<number> {
    return new Promise((resolve) => {
      this.dhcpResolve = resolve
      this.xid += 1
      this.sendDhcp(1 /* DISCOVER */, null)
    })
  }

  arpWhoHas(target: string): void {
    this.hooks.sendFrame(
      buildEth(
        MAC_BROADCAST,
        this.mac,
        ETHERTYPE_ARP,
        buildArp({
          op: ARP_REQUEST,
          senderMac: this.mac,
          senderIp: this.ip,
          targetMac: new Uint8Array(6),
          targetIp: ipFromString(target)!,
        }),
      ),
    )
  }

  /** ICMP echo; resolves when the reply for this sequence number arrives. */
  ping(dst: string, seq = 1): Promise<void> {
    return new Promise((resolve) => {
      this.pingWaiters.set(seq, resolve)
      this.sendIpv4(
        this.ip,
        ipFromString(dst)!,
        IPPROTO_ICMP,
        buildIcmp({ type: ICMP_ECHO_REQUEST, code: 0, id: 0x2b2b, seq, payload: encoder.encode('zephyr-in-the-browser') }),
      )
    })
  }

  /** DNS A lookup against the stack's server; resolves with the address. */
  resolveName(name: string): Promise<number> {
    return new Promise((resolve) => {
      const port = this.allocPort()
      const query = this.buildDnsQuery(name)
      const unsub = this.udpListen(port, (_src, payload) => {
        // Minimal parse: last 4 bytes of the first A answer.
        if (payload.length < 12 + 4) return
        const view = viewOf(payload)
        if (view.getUint16(0) !== (query.id & 0xffff) || view.getUint16(6) < 1) return
        unsub()
        resolve(view.getUint32(payload.length - 4))
      })
      this.sendUdp(port, this.dnsServer, 53, query.bytes)
    })
  }

  /** HTTP GET via name resolution — drives DNS + the outbound proxy. */
  async httpGet(name: string, path: string): Promise<{ status: number; text: string }> {
    const ip = await this.resolveName(name)
    const chunks: Uint8Array[] = []
    await new Promise<void>((resolve) => {
      this.tcp.connect(
        { ip: this.ip, port: this.allocPort() },
        { ip, port: 80 },
        {
          onOpen: (s) =>
            s.send(encoder.encode(`GET ${path} HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`)),
          onData: (_s, data) => chunks.push(data),
          onRemoteClose: (s) => {
            s.close()
            resolve()
          },
          onClose: () => resolve(),
          onReset: () => resolve(),
        },
      )
    })
    const raw = decoder.decode(concat(chunks))
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0)
    const headEnd = raw.indexOf('\r\n\r\n')
    return { status, text: headEnd >= 0 ? raw.slice(headEnd + 4) : '' }
  }

  /** A one-page HTTP server, dumb_http_server style. */
  serveHttp(port: number, body: string): void {
    this.tcp.listen({ port }, (socket) => {
      let got: Uint8Array = new Uint8Array(0)
      socket.handlers = {
        onData: (s, data) => {
          got = concat([got, data])
          if (indexOf(got, '\r\n\r\n') < 0) return
          const payload = encoder.encode(body)
          s.send(
            encoder.encode(
              `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n`,
            ),
          )
          s.send(payload)
          s.close()
        },
      }
    })
  }

  /** TCP + UDP echo on one port, echo_server style. */
  echoServer(port: number): void {
    this.tcp.listen({ port }, (socket) => {
      socket.handlers = {
        onData: (s, data) => s.send(data),
        onRemoteClose: (s) => s.close(),
      }
    })
    this.udpListen(port, (src, payload) => this.sendUdp(port, src.ip, src.port, payload))
  }

  udpListen(port: number, handler: (src: { ip: number; port: number }, payload: Uint8Array) => void): () => void {
    const entry = { port, handler }
    this.udpHandlers.push(entry)
    return () => {
      this.udpHandlers = this.udpHandlers.filter((h) => h !== entry)
    }
  }

  sendUdp(srcPort: number, dstIp: number, dstPort: number, payload: Uint8Array): void {
    this.sendIpv4(this.ip, dstIp, IPPROTO_UDP, buildUdp(this.ip, dstIp, srcPort, dstPort, payload))
  }

  connectTcp(dstIp: number, dstPort: number, handlers: TcpSocket['handlers']): TcpSocket {
    return this.tcp.connect({ ip: this.ip, port: this.allocPort() }, { ip: dstIp, port: dstPort }, handlers)
  }

  /* ----------------------------------------------------------- internals */

  private sendIpv4(src: number, dst: number, proto: number, payload: Uint8Array): void {
    // The gateway answers for everything, so every frame goes to it; before
    // any ARP exchange the broadcast address still reaches the stack.
    this.hooks.sendFrame(buildEth(MAC_BROADCAST, this.mac, ETHERTYPE_IPV4, buildIpv4(src, dst, proto, payload)))
  }

  private emitTcp(out: TcpEmit): void {
    this.sendIpv4(out.src.ip, out.dst.ip, IPPROTO_TCP, buildTcpSegment(out.src.ip, out.dst.ip, out.seg))
  }

  private allocPort(): number {
    this.ephemeral = this.ephemeral >= 65000 ? 40000 : this.ephemeral + 1
    return this.ephemeral
  }

  private sendDhcp(msgType: number, requestedIp: number | null): void {
    const msg = new Uint8Array(300)
    const view = viewOf(msg)
    msg[0] = 1 // BOOTREQUEST
    msg[1] = 1
    msg[2] = 6
    view.setUint32(4, this.xid)
    view.setUint16(10, 0x8000) // broadcast flag
    msg.set(this.mac, 28)
    view.setUint32(236, 0x63825363)
    let i = 240
    msg.set([53, 1, msgType], i)
    i += 3
    if (requestedIp !== null) {
      msg.set([50, 4], i)
      view.setUint32(i + 2, requestedIp)
      i += 6
    }
    msg[i] = 255
    const udp = buildUdp(0, 0xffffffff, DHCP_CLIENT_PORT, DHCP_SERVER_PORT, msg.subarray(0, i + 1))
    this.hooks.sendFrame(buildEth(MAC_BROADCAST, this.mac, ETHERTYPE_IPV4, buildIpv4(0, 0xffffffff, IPPROTO_UDP, udp)))
  }

  private onDhcpReply(payload: Uint8Array): void {
    const msg = parseDhcp(payload)
    if (!msg || msg.xid !== this.xid) return
    if (msg.msgType === DHCP_OFFER) {
      this.sendDhcp(3 /* REQUEST */, msg.yiaddr)
    } else if (msg.msgType === DHCP_ACK) {
      this.ip = msg.yiaddr
      this.dhcpResolve?.(msg.yiaddr)
      this.dhcpResolve = null
    }
  }

  private buildDnsQuery(name: string): { id: number; bytes: Uint8Array } {
    const id = Math.floor(this.hooks.random() * 0xffff)
    const labels = name.split('.')
    const qname: number[] = []
    for (const label of labels) {
      qname.push(label.length, ...encoder.encode(label))
    }
    qname.push(0)
    const bytes = new Uint8Array(12 + qname.length + 4)
    const view = viewOf(bytes)
    view.setUint16(0, id)
    view.setUint16(2, 0x0100)
    view.setUint16(4, 1)
    bytes.set(qname, 12)
    view.setUint16(12 + qname.length, DNS_TYPE_A)
    view.setUint16(12 + qname.length + 2, 1)
    return { id, bytes }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function indexOf(haystack: Uint8Array, needle: string): number {
  const n = encoder.encode(needle)
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer
    return i
  }
  return -1
}
