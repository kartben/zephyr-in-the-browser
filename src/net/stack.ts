/**
 * The LAN, as a TypeScript object.
 *
 * Every frame the guest transmits terminates here, and every frame it
 * receives originates here — there is no routing, only dispatch. The stack
 * plays gateway, DHCP/DNS/SNTP server, every "internet" host at once (via
 * synthetic addresses and the fetch()-backed HTTP proxy), and a TCP/UDP
 * client dialing into servers the guest runs.
 *
 * Addressing (defaults):
 *   192.0.2.0/24   the LAN (matches Zephyr's net_config sample defaults)
 *   192.0.2.1      the one DHCP lease — static samples use the same value
 *   192.0.2.2      gateway / DHCP / SNTP / "host.internal"
 *   192.0.2.3      DNS
 *   192.0.2.4      echo host ("echo.internal")
 *   203.0.113.0/24 synthetic pool for resolved names
 *
 * Proxy-ARP: the stack answers ARP for *any* address except the guest's own
 * (and its DHCP-probe target), so off-subnet or slirp-style guest configs
 * resolve and just work. The exception is load-bearing: answering the
 * guest's address-conflict probe would make every DHCP lease look taken.
 */

import { ipFromString, macFromString, MAC_BROADCAST } from './bytes'
import { parseArp, buildArp, ARP_REPLY, ARP_REQUEST } from './arp'
import { buildEth, parseEth, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from './ethernet'
import { buildEchoReply, parseIcmp, ICMP_ECHO_REQUEST } from './icmp'
import { buildIpv4, parseIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from './ipv4'
import { buildUdp, parseUdp } from './udp'
import {
  buildDhcpReply,
  parseDhcp,
  DHCP_ACK,
  DHCP_DISCOVER,
  DHCP_NAK,
  DHCP_OFFER,
  DHCP_REQUEST,
  DHCP_SERVER_PORT,
  DHCP_CLIENT_PORT,
} from './dhcp'
import { buildDnsResponse, parseDnsQuery, DNS_TYPE_A, DNS_TYPE_AAAA } from './dns'
import { buildSntpReply, isSntpRequest, SNTP_PORT } from './sntp'
import { parseTcpSegment, buildTcpSegment } from './tcpWire'
import { rstReplyFor, TcpEngine, type TcpEmit } from './tcp'

export type DhcpState = 'waiting' | 'offered' | 'bound' | 'static'

export type StackEvent =
  | { kind: 'guest-mac'; mac: Uint8Array }
  | { kind: 'guest-ip'; ip: number; dhcpState: DhcpState }
  | { kind: 'dns'; name: string; ip: number; source: 'doh' | 'synthetic' | 'internal' }

export interface StackHooks {
  /** Put one Ethernet frame on the guest-bound wire. */
  sendFrame(frame: Uint8Array): void
  now(): number
  random(): number
  /** null: offline / mock — DNS degrades to synthetic answers. */
  fetchImpl: typeof fetch | null
  onEvent?(event: StackEvent): void
}

export interface StackConfig {
  gatewayIp?: string
  dnsIp?: string
  leaseIp?: string
  echoIp?: string
}

export type UdpHandler = (datagram: {
  srcIp: number
  srcPort: number
  dstIp: number
  dstPort: number
  payload: Uint8Array
}) => void

const DOH_TIMEOUT_MS = 1500
const LEASE_SECS = 86400
const SUBNET_MASK = 0xffffff00

export class NetStack {
  readonly hooks: StackHooks
  readonly gwMac = macFromString('52:55:0a:00:02:02')!
  readonly gwIp: number
  readonly dnsIp: number
  readonly leaseIp: number
  readonly echoIp: number
  readonly tcp: TcpEngine

  guestMac: Uint8Array | null = null
  guestIp: number | null = null
  dhcpState: DhcpState = 'waiting'

  /** name -> address, and back; synthetic pool allocation is sequential. */
  private names = new Map<string, number>()
  private ipNames = new Map<number, string>()
  private nextSynthetic: number
  private udpListeners: Array<{ port: number; ip: number | null; handler: UdpHandler }> = []
  private ephemeralPort = 49500
  private aborter = new AbortController()
  private disposed = false
  private lastProbeAt = 0

  constructor(hooks: StackHooks, config: StackConfig = {}) {
    this.hooks = hooks
    this.gwIp = ipFromString(config.gatewayIp ?? '192.0.2.2')!
    this.dnsIp = ipFromString(config.dnsIp ?? '192.0.2.3')!
    this.leaseIp = ipFromString(config.leaseIp ?? '192.0.2.1')!
    this.echoIp = ipFromString(config.echoIp ?? '192.0.2.4')!
    this.nextSynthetic = ipFromString('203.0.113.1')!
    this.tcp = new TcpEngine({
      emit: (out) => this.emitTcp(out),
      now: () => hooks.now(),
      randomSeq: () => Math.floor(hooks.random() * 0xffffffff) >>> 0,
    })
    this.registerName('host.internal', this.gwIp)
    this.registerName('echo.internal', this.echoIp)
  }

  /* ------------------------------------------------------------- ingress */

  onGuestFrame(frame: Uint8Array): void {
    if (this.disposed) return
    const eth = parseEth(frame)
    if (!eth) return

    if (!this.guestMac && !isBroadcast(eth.src)) {
      this.guestMac = eth.src.slice()
      this.hooks.onEvent?.({ kind: 'guest-mac', mac: this.guestMac })
    }

    if (eth.etherType === ETHERTYPE_ARP) this.onArp(eth.payload)
    else if (eth.etherType === ETHERTYPE_IPV4) this.onIpv4(eth.payload)
    // IPv6 and anything else: out of scope, silently ignored.
  }

  tick(): void {
    this.tcp.tick()
    // A statically-configured guest can sit silent until something talks to
    // it (dumb_http_server boots straight into accept()). Probe for the
    // conventional address until the guest shows itself, so the panel can
    // report MAC/IP and unlock its tools.
    if (this.guestIp === null) {
      const now = this.hooks.now()
      if (now - this.lastProbeAt >= 2000) {
        this.lastProbeAt = now
        this.hooks.sendFrame(
          buildEth(
            MAC_BROADCAST,
            this.gwMac,
            ETHERTYPE_ARP,
            buildArp({
              op: ARP_REQUEST,
              senderMac: this.gwMac,
              senderIp: this.gwIp,
              targetMac: new Uint8Array(6),
              targetIp: this.leaseIp,
            }),
          ),
        )
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.aborter.abort()
    this.tcp.dispose()
    this.udpListeners = []
  }

  /* -------------------------------------------------------------- egress */

  /** Wrap an IPv4 payload for the guest and put it on the wire. */
  sendIpv4ToGuest(srcIp: number, dstIp: number, proto: number, payload: Uint8Array): void {
    const dstMac = this.guestMac ?? MAC_BROADCAST
    this.hooks.sendFrame(buildEth(dstMac, this.gwMac, ETHERTYPE_IPV4, buildIpv4(srcIp, dstIp, proto, payload)))
  }

  sendUdpToGuest(srcIp: number, srcPort: number, dstIp: number, dstPort: number, payload: Uint8Array): void {
    this.sendIpv4ToGuest(srcIp, dstIp, IPPROTO_UDP, buildUdp(srcIp, dstIp, srcPort, dstPort, payload))
  }

  /* ------------------------------------------------------------ services */

  udpListen(match: { port: number; ip?: number | null }, handler: UdpHandler): () => void {
    const entry = { port: match.port, ip: match.ip ?? null, handler }
    this.udpListeners.push(entry)
    return () => {
      this.udpListeners = this.udpListeners.filter((l) => l !== entry)
    }
  }

  registerName(name: string, ip: number): void {
    this.names.set(name.toLowerCase(), ip)
    this.ipNames.set(ip, name.toLowerCase())
  }

  nameForIp(ip: number): string | null {
    return this.ipNames.get(ip) ?? null
  }

  ipForName(name: string): number | null {
    return this.names.get(name.toLowerCase()) ?? null
  }

  allocEphemeralPort(): number {
    this.ephemeralPort = this.ephemeralPort >= 65500 ? 49500 : this.ephemeralPort + 1
    return this.ephemeralPort
  }

  get abortSignal(): AbortSignal {
    return this.aborter.signal
  }

  /* ----------------------------------------------------------------- ARP */

  private onArp(payload: Uint8Array): void {
    const arp = parseArp(payload)
    if (!arp) return

    if (arp.senderIp !== 0) this.learnGuestIp(arp.senderIp)
    if (arp.op !== ARP_REQUEST) return

    // Stay silent for the guest's own address: gratuitous ARP and the
    // address-conflict probe DHCP clients send for their offered lease.
    if (arp.targetIp === this.guestIp || arp.targetIp === this.leaseIp) return
    if (arp.targetIp === 0) return

    const reply = buildArp({
      op: ARP_REPLY,
      senderMac: this.gwMac,
      senderIp: arp.targetIp, // proxy-ARP: we are everyone
      targetMac: arp.senderMac,
      targetIp: arp.senderIp,
    })
    const dstMac = isBroadcast(arp.senderMac) || arp.senderIp === 0 ? this.guestMac ?? MAC_BROADCAST : arp.senderMac
    this.hooks.sendFrame(buildEth(dstMac, this.gwMac, ETHERTYPE_ARP, reply))
  }

  /* ---------------------------------------------------------------- IPv4 */

  private onIpv4(payload: Uint8Array): void {
    const ip = parseIpv4(payload)
    if (!ip) return
    if (ip.src !== 0 && ip.src !== 0xffffffff) this.learnGuestIp(ip.src)

    if (ip.proto === IPPROTO_ICMP) {
      const icmp = parseIcmp(ip.payload)
      if (icmp?.type === ICMP_ECHO_REQUEST) {
        // Any destination answers: the whole internet is one hop away.
        this.sendIpv4ToGuest(ip.dst, ip.src, IPPROTO_ICMP, buildEchoReply(icmp))
      }
      return
    }

    if (ip.proto === IPPROTO_UDP) {
      const udp = parseUdp(ip.payload)
      if (!udp) return
      this.onUdp(ip.src, ip.dst, udp.srcPort, udp.dstPort, udp.payload)
      return
    }

    if (ip.proto === IPPROTO_TCP) {
      const seg = parseTcpSegment(ip.payload)
      if (!seg) return
      if (!this.tcp.onSegment(ip.src, ip.dst, seg)) {
        const rst = rstReplyFor(seg)
        this.sendIpv4ToGuest(ip.dst, ip.src, IPPROTO_TCP, buildTcpSegment(ip.dst, ip.src, rst))
      }
    }
  }

  /* ----------------------------------------------------------------- UDP */

  private onUdp(srcIp: number, dstIp: number, srcPort: number, dstPort: number, payload: Uint8Array): void {
    if (dstPort === DHCP_SERVER_PORT) {
      this.onDhcp(payload)
      return
    }
    if (dstPort === 53) {
      this.onDns(srcIp, srcPort, dstIp, payload)
      return
    }
    if (dstPort === SNTP_PORT && isSntpRequest(payload)) {
      this.sendUdpToGuest(dstIp, SNTP_PORT, srcIp, srcPort, buildSntpReply(payload, this.hooks.now()))
      return
    }
    const listener = this.udpListeners.find((l) => l.port === dstPort && (l.ip === null || l.ip === dstIp))
    listener?.handler({ srcIp, srcPort, dstIp, dstPort, payload })
    // No listener: silently dropped, like an unfiltered real network.
  }

  /* ---------------------------------------------------------------- DHCP */

  private onDhcp(payload: Uint8Array): void {
    const msg = parseDhcp(payload)
    if (!msg || msg.op !== 1) return

    const reply = (msgType: number, yiaddr: number) =>
      buildDhcpReply({
        msgType,
        xid: msg.xid,
        chaddr: msg.chaddr,
        yiaddr,
        serverId: this.gwIp,
        subnetMask: SUBNET_MASK,
        router: this.gwIp,
        dns: this.dnsIp,
        sntp: this.gwIp,
        leaseSecs: LEASE_SECS,
      })

    if (msg.msgType === DHCP_DISCOVER) {
      this.dhcpState = 'offered'
      this.sendDhcpReply(msg.broadcast, msg.chaddr, reply(DHCP_OFFER, this.leaseIp), this.leaseIp)
      return
    }
    if (msg.msgType === DHCP_REQUEST) {
      const requested = msg.requestedIp ?? msg.ciaddr
      if (requested === this.leaseIp || requested === 0) {
        this.guestIp = this.leaseIp
        this.dhcpState = 'bound'
        this.hooks.onEvent?.({ kind: 'guest-ip', ip: this.leaseIp, dhcpState: 'bound' })
        this.sendDhcpReply(msg.broadcast, msg.chaddr, reply(DHCP_ACK, this.leaseIp), this.leaseIp)
      } else {
        this.sendDhcpReply(true, msg.chaddr, reply(DHCP_NAK, 0), 0xffffffff)
      }
    }
  }

  private sendDhcpReply(broadcast: boolean, chaddr: Uint8Array, dhcp: Uint8Array, yiaddr: number): void {
    // RFC 2131 delivery: broadcast when asked (or NAK), else unicast to the
    // offered address at the client's MAC.
    const wantBroadcast = broadcast || yiaddr === 0xffffffff
    const dstIp = wantBroadcast ? 0xffffffff : yiaddr
    const dstMac = wantBroadcast ? MAC_BROADCAST : chaddr
    const udp = buildUdp(this.gwIp, dstIp, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, dhcp)
    this.hooks.sendFrame(buildEth(dstMac, this.gwMac, ETHERTYPE_IPV4, buildIpv4(this.gwIp, dstIp, IPPROTO_UDP, udp)))
  }

  /* ----------------------------------------------------------------- DNS */

  private onDns(srcIp: number, srcPort: number, dstIp: number, payload: Uint8Array): void {
    const query = parseDnsQuery(payload)
    if (!query) return
    const respond = (ips: number[]) => {
      if (this.disposed) return
      this.sendUdpToGuest(dstIp, 53, srcIp, srcPort, buildDnsResponse(query, ips))
    }

    if (query.qtype === DNS_TYPE_AAAA) {
      respond([]) // IPv4-only network: empty NOERROR pushes clients to A
      return
    }
    if (query.qtype !== DNS_TYPE_A) {
      respond([])
      return
    }

    const known = this.names.get(query.name)
    if (known !== undefined) {
      this.hooks.onEvent?.({ kind: 'dns', name: query.name, ip: known, source: 'internal' })
      respond([known])
      return
    }

    const synthetic = this.allocSynthetic(query.name)
    if (!this.hooks.fetchImpl) {
      this.hooks.onEvent?.({ kind: 'dns', name: query.name, ip: synthetic, source: 'synthetic' })
      respond([synthetic])
      return
    }

    // Race DoH against a timeout; either way the name maps to *something*
    // and outbound TCP dispatches on the name, so the answer is cosmetic.
    this.resolveDoh(query.name)
      .then((real) => {
        if (real !== null) {
          this.registerName(query.name, real)
          this.hooks.onEvent?.({ kind: 'dns', name: query.name, ip: real, source: 'doh' })
          respond([real])
        } else {
          this.hooks.onEvent?.({ kind: 'dns', name: query.name, ip: synthetic, source: 'synthetic' })
          respond([synthetic])
        }
      })
      .catch(() => respond([synthetic]))
  }

  private allocSynthetic(name: string): number {
    const existing = this.names.get(name)
    if (existing !== undefined) return existing
    const ip = this.nextSynthetic
    this.nextSynthetic += 1
    this.registerName(name, ip)
    return ip
  }

  private async resolveDoh(name: string): Promise<number | null> {
    const fetchImpl = this.hooks.fetchImpl
    if (!fetchImpl) return null
    const timeout = AbortSignal.timeout(DOH_TIMEOUT_MS)
    const signal =
      'any' in AbortSignal ? AbortSignal.any([timeout, this.aborter.signal]) : timeout
    try {
      const res = await fetchImpl(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`, {
        signal,
        headers: { accept: 'application/dns-json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> }
      const a = body.Answer?.find((r) => r.type === 1)
      return a ? ipFromString(a.data) : null
    } catch {
      return null
    }
  }

  /* ----------------------------------------------------------------- TCP */

  private emitTcp(out: TcpEmit): void {
    // Symmetric engine, asymmetric wire: every peer of ours is the guest.
    this.sendIpv4ToGuest(out.src.ip, out.dst.ip, IPPROTO_TCP, buildTcpSegment(out.src.ip, out.dst.ip, out.seg))
  }

  private learnGuestIp(ip: number): void {
    if (this.guestIp === ip) return
    // DHCP owns the address while a handshake is in flight or bound.
    if (this.dhcpState === 'bound' || this.dhcpState === 'offered') {
      if (ip !== this.leaseIp) return
      this.guestIp = ip
      return
    }
    this.guestIp = ip
    this.dhcpState = 'static'
    this.hooks.onEvent?.({ kind: 'guest-ip', ip, dhcpState: 'static' })
  }
}

function isBroadcast(mac: Uint8Array): boolean {
  return mac[0] === 0xff && mac[1] === 0xff && mac[2] === 0xff && mac[3] === 0xff && mac[4] === 0xff && mac[5] === 0xff
}
