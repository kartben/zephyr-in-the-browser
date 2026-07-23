/**
 * One-line frame summaries for the capture list — the tcpdump squint test.
 * Lenient by design: every parser failure degrades to a raw-Ethernet line.
 */

import { ipToString } from './bytes'
import { parseArp, ARP_REQUEST } from './arp'
import { parseEth, ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6 } from './ethernet'
import { parseIcmp, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST } from './icmp'
import { parseIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from './ipv4'
import { dhcpTypeName, parseDhcp, DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from './dhcp'
import { parseDnsQuery, DNS_TYPE_A, DNS_TYPE_AAAA } from './dns'
import { SNTP_PORT } from './sntp'
import { parseTcpSegment, tcpFlagsToString } from './tcpWire'
import { parseUdp } from './udp'

export interface FrameSummary {
  /** Badge label: ARP, DHCP, DNS, ICMP, TCP, UDP, SNTP, HTTP, ETH, IPv6. */
  proto: string
  text: string
}

export function summarize(frame: Uint8Array): FrameSummary {
  const eth = parseEth(frame)
  if (!eth) return { proto: 'ETH', text: `malformed frame, ${frame.length} B` }

  if (eth.etherType === ETHERTYPE_ARP) {
    const arp = parseArp(eth.payload)
    if (!arp) return { proto: 'ARP', text: 'malformed ARP' }
    return arp.op === ARP_REQUEST
      ? { proto: 'ARP', text: `who has ${ipToString(arp.targetIp)}? tell ${ipToString(arp.senderIp)}` }
      : { proto: 'ARP', text: `${ipToString(arp.senderIp)} is at ${fmtMac(arp.senderMac)}` }
  }

  if (eth.etherType === ETHERTYPE_IPV6) {
    return { proto: 'IPv6', text: `${eth.payload.length} B (not decoded)` }
  }

  if (eth.etherType !== ETHERTYPE_IPV4) {
    return { proto: 'ETH', text: `ethertype 0x${eth.etherType.toString(16).padStart(4, '0')}, ${frame.length} B` }
  }

  const ip = parseIpv4(eth.payload)
  if (!ip) return { proto: 'IPv4', text: 'fragment or malformed' }
  const route = `${ipToString(ip.src)} → ${ipToString(ip.dst)}`

  if (ip.proto === IPPROTO_ICMP) {
    const icmp = parseIcmp(ip.payload)
    if (!icmp) return { proto: 'ICMP', text: `${route} malformed` }
    const kind =
      icmp.type === ICMP_ECHO_REQUEST ? 'echo request' : icmp.type === ICMP_ECHO_REPLY ? 'echo reply' : `type ${icmp.type}`
    return { proto: 'ICMP', text: `${route} ${kind} id=${icmp.id} seq=${icmp.seq}` }
  }

  if (ip.proto === IPPROTO_UDP) {
    const udp = parseUdp(ip.payload)
    if (!udp) return { proto: 'UDP', text: `${route} malformed` }
    const ports = { src: udp.srcPort, dst: udp.dstPort }

    if (ports.dst === DHCP_SERVER_PORT || ports.dst === DHCP_CLIENT_PORT) {
      const dhcp = parseDhcp(udp.payload)
      if (dhcp) return { proto: 'DHCP', text: `${dhcpTypeName(dhcp.msgType)} xid=0x${dhcp.xid.toString(16)}` }
    }
    if (ports.dst === 53 || ports.src === 53) {
      const query = parseDnsQuery(udp.payload)
      if (query) {
        const qt = query.qtype === DNS_TYPE_A ? 'A' : query.qtype === DNS_TYPE_AAAA ? 'AAAA' : `type${query.qtype}`
        return { proto: 'DNS', text: `${qt}? ${query.name}` }
      }
      return { proto: 'DNS', text: `${route} response, ${udp.payload.length} B` }
    }
    if (ports.dst === SNTP_PORT || ports.src === SNTP_PORT) {
      return { proto: 'SNTP', text: ports.dst === SNTP_PORT ? 'request' : 'reply' }
    }
    return { proto: 'UDP', text: `${ipToString(ip.src)}:${ports.src} → ${ipToString(ip.dst)}:${ports.dst} len=${udp.payload.length}` }
  }

  if (ip.proto === IPPROTO_TCP) {
    const tcp = parseTcpSegment(ip.payload)
    if (!tcp) return { proto: 'TCP', text: `${route} malformed` }
    const flow = `${ipToString(ip.src)}:${tcp.srcPort} → ${ipToString(ip.dst)}:${tcp.dstPort}`
    const httpLine = firstHttpLine(tcp.payload)
    if (httpLine) return { proto: 'HTTP', text: `${flow} ${httpLine}` }
    const parts = [`[${tcpFlagsToString(tcp.flags)}]`]
    if (tcp.payload.length > 0) parts.push(`len=${tcp.payload.length}`)
    if (tcp.mss !== undefined) parts.push(`mss=${tcp.mss}`)
    return { proto: 'TCP', text: `${flow} ${parts.join(' ')}` }
  }

  return { proto: 'IPv4', text: `${route} proto=${ip.proto} len=${ip.payload.length}` }
}

/** The request/status line when a TCP payload starts like HTTP, else null. */
function firstHttpLine(payload: Uint8Array): string | null {
  if (payload.length < 5) return null
  const head = new TextDecoder().decode(payload.subarray(0, Math.min(payload.length, 80)))
  if (!/^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH|HTTP\/1)/.test(head)) return null
  const eol = head.indexOf('\r\n')
  return eol > 0 ? head.slice(0, eol) : head
}

function fmtMac(mac: Uint8Array): string {
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(':')
}
