import { describe, expect, it } from 'vitest'
import { checksum16, ipFromString, ipToString, macFromString, macToString, pseudoHeaderSum } from './bytes'
import { ARP_REPLY, ARP_REQUEST, buildArp, parseArp } from './arp'
import { buildEth, parseEth, ETHERTYPE_ARP } from './ethernet'
import { buildIcmp, buildEchoReply, parseIcmp, ICMP_ECHO_REPLY, ICMP_ECHO_REQUEST } from './icmp'
import { buildIpv4, parseIpv4, IPPROTO_TCP, IPPROTO_UDP } from './ipv4'
import { buildUdp, parseUdp } from './udp'
import { buildTcpSegment, parseTcpSegment, TCP_ACK, TCP_SYN } from './tcpWire'
import { buildDhcpReply, parseDhcp, DHCP_OFFER } from './dhcp'
import { buildDnsResponse, buildDnsNxdomain, parseDnsQuery, DNS_TYPE_A } from './dns'
import { buildSntpReply, isSntpRequest } from './sntp'

const sum16 = checksum16

const GUEST_MAC = macFromString('02:00:00:00:00:01')!
const GW_MAC = macFromString('52:55:0a:00:02:02')!
const GUEST_IP = ipFromString('192.0.2.1')!
const GW_IP = ipFromString('192.0.2.2')!

describe('bytes', () => {
  it('computes the RFC 1071 example IPv4 header checksum', () => {
    // 172.16.10.99 -> 172.16.10.12, the classic worked example.
    const header = Uint8Array.from([
      0x45, 0x00, 0x00, 0x3c, 0x1c, 0x46, 0x40, 0x00, 0x40, 0x06, 0x00, 0x00,
      0xac, 0x10, 0x0a, 0x63, 0xac, 0x10, 0x0a, 0x0c,
    ])
    expect(checksum16(header)).toBe(0xb1e6)
  })

  it('roundtrips IP and MAC strings', () => {
    expect(ipToString(ipFromString('10.0.2.15')!)).toBe('10.0.2.15')
    expect(ipFromString('256.0.0.1')).toBeNull()
    expect(ipFromString('1.2.3')).toBeNull()
    expect(macToString(macFromString('aa:BB:0c:0d:0e:0f')!)).toBe('aa:bb:0c:0d:0e:0f')
    expect(macFromString('aa:bb:cc')).toBeNull()
  })
})

describe('ethernet', () => {
  it('roundtrips a frame', () => {
    const frame = buildEth(GW_MAC, GUEST_MAC, ETHERTYPE_ARP, Uint8Array.of(1, 2, 3))
    const eth = parseEth(frame)!
    expect(macToString(eth.dst)).toBe(macToString(GW_MAC))
    expect(macToString(eth.src)).toBe(macToString(GUEST_MAC))
    expect(eth.etherType).toBe(ETHERTYPE_ARP)
    expect([...eth.payload]).toEqual([1, 2, 3])
  })

  it('rejects a truncated frame', () => {
    expect(parseEth(new Uint8Array(13))).toBeNull()
  })
})

describe('arp', () => {
  it('roundtrips request and reply', () => {
    const req = buildArp({
      op: ARP_REQUEST,
      senderMac: GUEST_MAC,
      senderIp: GUEST_IP,
      targetMac: new Uint8Array(6),
      targetIp: GW_IP,
    })
    const parsed = parseArp(req)!
    expect(parsed.op).toBe(ARP_REQUEST)
    expect(parsed.senderIp).toBe(GUEST_IP)
    expect(parsed.targetIp).toBe(GW_IP)

    const reply = parseArp(
      buildArp({ op: ARP_REPLY, senderMac: GW_MAC, senderIp: GW_IP, targetMac: GUEST_MAC, targetIp: GUEST_IP }),
    )!
    expect(reply.op).toBe(ARP_REPLY)
    expect(macToString(reply.senderMac)).toBe(macToString(GW_MAC))
  })

  it('rejects non-Ethernet/IPv4 ARP', () => {
    const bogus = buildArp({
      op: ARP_REQUEST,
      senderMac: GUEST_MAC,
      senderIp: GUEST_IP,
      targetMac: new Uint8Array(6),
      targetIp: GW_IP,
    })
    bogus[1] = 9 // hardware type
    expect(parseArp(bogus)).toBeNull()
  })
})

describe('ipv4', () => {
  it('roundtrips and self-checksums', () => {
    const packet = buildIpv4(GUEST_IP, GW_IP, IPPROTO_UDP, Uint8Array.of(9, 9, 9))
    // Verify the emitted header checksum is valid: folding over it yields 0.
    expect(checksum16(packet.subarray(0, 20))).toBe(0)
    const parsed = parseIpv4(packet)!
    expect(parsed.src).toBe(GUEST_IP)
    expect(parsed.dst).toBe(GW_IP)
    expect(parsed.proto).toBe(IPPROTO_UDP)
    expect([...parsed.payload]).toEqual([9, 9, 9])
  })

  it('drops fragments', () => {
    const packet = buildIpv4(GUEST_IP, GW_IP, IPPROTO_UDP, Uint8Array.of(1))
    packet[6] |= 0x20 // MF
    expect(parseIpv4(packet)).toBeNull()
  })

  it('ignores trailing Ethernet padding beyond total-length', () => {
    const packet = buildIpv4(GUEST_IP, GW_IP, IPPROTO_UDP, Uint8Array.of(7))
    const padded = new Uint8Array(packet.length + 14)
    padded.set(packet)
    const parsed = parseIpv4(padded)!
    expect([...parsed.payload]).toEqual([7])
  })
})

describe('icmp', () => {
  it('builds a valid echo reply from a request', () => {
    const request = parseIcmp(
      buildIcmp({ type: ICMP_ECHO_REQUEST, code: 0, id: 0x1234, seq: 7, payload: Uint8Array.of(1, 2, 3, 4) }),
    )!
    const reply = parseIcmp(buildEchoReply(request))!
    expect(reply.type).toBe(ICMP_ECHO_REPLY)
    expect(reply.id).toBe(0x1234)
    expect(reply.seq).toBe(7)
    expect([...reply.payload]).toEqual([1, 2, 3, 4])
  })
})

describe('udp', () => {
  it('roundtrips with a valid checksum', () => {
    const data = new TextEncoder().encode('hello')
    const datagram = buildUdp(GUEST_IP, GW_IP, 49152, 4242, data)
    // Checksum over segment + pseudo-header folds to zero when valid.
    expect(sum16(datagram, pseudoHeaderSum(GUEST_IP, GW_IP, IPPROTO_UDP, datagram.length))).toBe(0)
    const parsed = parseUdp(datagram)!
    expect(parsed.srcPort).toBe(49152)
    expect(parsed.dstPort).toBe(4242)
    expect(new TextDecoder().decode(parsed.payload)).toBe('hello')
  })
})

describe('tcpWire', () => {
  it('roundtrips a SYN with MSS and self-checksums', () => {
    const syn = buildTcpSegment(GW_IP, GUEST_IP, {
      srcPort: 50000,
      dstPort: 8080,
      seq: 0xdeadbeef,
      ack: 0,
      flags: TCP_SYN,
      window: 65535,
      payload: new Uint8Array(0),
      mss: 1460,
    })
    expect(sum16(syn, pseudoHeaderSum(GW_IP, GUEST_IP, IPPROTO_TCP, syn.length))).toBe(0)
    const parsed = parseTcpSegment(syn)!
    expect(parsed.seq).toBe(0xdeadbeef)
    expect(parsed.flags).toBe(TCP_SYN)
    expect(parsed.mss).toBe(1460)
  })

  it('parses payload past options', () => {
    const seg = buildTcpSegment(GUEST_IP, GW_IP, {
      srcPort: 1,
      dstPort: 2,
      seq: 1,
      ack: 2,
      flags: TCP_ACK,
      window: 1024,
      payload: new TextEncoder().encode('data'),
    })
    const parsed = parseTcpSegment(seg)!
    expect(new TextDecoder().decode(parsed.payload)).toBe('data')
    expect(parsed.mss).toBeUndefined()
  })
})

describe('dhcp', () => {
  it('roundtrips an Offer', () => {
    const offer = buildDhcpReply({
      msgType: DHCP_OFFER,
      xid: 0x22334455,
      chaddr: GUEST_MAC,
      yiaddr: GUEST_IP,
      serverId: GW_IP,
      subnetMask: ipFromString('255.255.255.0')!,
      router: GW_IP,
      dns: ipFromString('192.0.2.3')!,
      sntp: GW_IP,
      leaseSecs: 86400,
    })
    const parsed = parseDhcp(offer)!
    expect(parsed.op).toBe(2)
    expect(parsed.msgType).toBe(DHCP_OFFER)
    expect(parsed.xid).toBe(0x22334455)
    expect(parsed.yiaddr).toBe(GUEST_IP)
    expect(parsed.serverId).toBe(GW_IP)
    expect(macToString(parsed.chaddr)).toBe(macToString(GUEST_MAC))
  })

  it('parses a client Discover with requested IP', () => {
    // Hand-assembled minimal DISCOVER.
    const msg = new Uint8Array(244)
    msg[0] = 1 // BOOTREQUEST
    msg[1] = 1
    msg[2] = 6
    msg.set([0x12, 0x34, 0x56, 0x78], 4) // xid
    msg.set(GUEST_MAC, 28)
    msg.set([0x63, 0x82, 0x53, 0x63], 236) // cookie
    msg.set([53, 1, 1, 255], 240) // msg type: DISCOVER, then END
    const parsed = parseDhcp(msg)!
    expect(parsed.msgType).toBe(1)
    expect(parsed.xid).toBe(0x12345678)
  })
})

describe('dns', () => {
  function buildQuery(name: string, qtype = DNS_TYPE_A, id = 0xbeef): Uint8Array {
    const labels = name.split('.')
    const qname = new Uint8Array(name.length + 2)
    let i = 0
    for (const label of labels) {
      qname[i++] = label.length
      for (const ch of new TextEncoder().encode(label)) qname[i++] = ch
    }
    const out = new Uint8Array(12 + qname.length + 4)
    const view = new DataView(out.buffer)
    view.setUint16(0, id)
    view.setUint16(2, 0x0100) // RD
    view.setUint16(4, 1)
    out.set(qname, 12)
    view.setUint16(12 + qname.length, qtype)
    view.setUint16(12 + qname.length + 2, 1)
    return out
  }

  it('parses a query and builds a pointered A answer', () => {
    const query = parseDnsQuery(buildQuery('Example.COM'))!
    expect(query.name).toBe('example.com')
    expect(query.qtype).toBe(DNS_TYPE_A)

    const answerIp = ipFromString('203.0.113.7')!
    const response = buildDnsResponse(query, [answerIp], 60)
    const view = new DataView(response.buffer)
    expect(view.getUint16(0)).toBe(0xbeef)
    expect(view.getUint16(2) & 0x8000).toBe(0x8000) // QR
    expect(view.getUint16(6)).toBe(1) // ANCOUNT
    // The answer name is a pointer to offset 12; the RDATA is the IP.
    const answerOffset = 12 + query.question.length
    expect(view.getUint16(answerOffset)).toBe(0xc00c)
    expect(view.getUint32(answerOffset + 12)).toBe(answerIp)
  })

  it('builds NXDOMAIN', () => {
    const query = parseDnsQuery(buildQuery('nope.invalid'))!
    const response = buildDnsNxdomain(query)
    expect(new DataView(response.buffer).getUint16(2) & 0x000f).toBe(3)
  })

  it('rejects responses and empty questions', () => {
    const query = buildQuery('x.y')
    query[2] |= 0x80 // QR bit: a response
    expect(parseDnsQuery(query)).toBeNull()
  })
})

describe('sntp', () => {
  it('answers a client request with the supplied clock', () => {
    const request = new Uint8Array(48)
    request[0] = (4 << 3) | 3 // v4, client
    request.set([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44], 40) // client transmit
    expect(isSntpRequest(request)).toBe(true)

    const nowMs = Date.UTC(2026, 0, 1) // fixed instant
    const reply = buildSntpReply(request, nowMs)
    const view = new DataView(reply.buffer)
    expect(reply[0] & 0x07).toBe(4) // server mode
    expect(reply[1]).toBe(1) // stratum 1
    // Originate timestamp echoes the client's transmit field.
    expect([...reply.subarray(24, 32)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44])
    // Transmit seconds = unix seconds + 2208988800.
    expect(view.getUint32(40)).toBe(Math.floor(nowMs / 1000) + 2208988800)
  })
})
