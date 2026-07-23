import { describe, expect, it } from 'vitest'
import { ipFromString, macFromString } from './bytes'
import { buildArp, ARP_REQUEST } from './arp'
import { buildEth, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from './ethernet'
import { buildIcmp, ICMP_ECHO_REQUEST } from './icmp'
import { buildIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP } from './ipv4'
import { buildTcpSegment, TCP_SYN } from './tcpWire'
import { buildUdp } from './udp'
import { summarize } from './decode'

const MAC_A = macFromString('02:00:00:00:00:01')!
const MAC_B = macFromString('52:55:0a:00:02:02')!
const IP_A = ipFromString('192.0.2.1')!
const IP_B = ipFromString('192.0.2.2')!

describe('decode.summarize', () => {
  it('summarizes ARP requests', () => {
    const frame = buildEth(
      new Uint8Array(6).fill(0xff),
      MAC_A,
      ETHERTYPE_ARP,
      buildArp({ op: ARP_REQUEST, senderMac: MAC_A, senderIp: IP_A, targetMac: new Uint8Array(6), targetIp: IP_B }),
    )
    expect(summarize(frame)).toEqual({ proto: 'ARP', text: 'who has 192.0.2.2? tell 192.0.2.1' })
  })

  it('summarizes ICMP echo', () => {
    const frame = buildEth(
      MAC_B,
      MAC_A,
      ETHERTYPE_IPV4,
      buildIpv4(IP_A, IP_B, IPPROTO_ICMP, buildIcmp({ type: ICMP_ECHO_REQUEST, code: 0, id: 3, seq: 9, payload: new Uint8Array(4) })),
    )
    const s = summarize(frame)
    expect(s.proto).toBe('ICMP')
    expect(s.text).toBe('192.0.2.1 → 192.0.2.2 echo request id=3 seq=9')
  })

  it('summarizes TCP SYN with mss and HTTP payloads', () => {
    const syn = buildEth(
      MAC_B,
      MAC_A,
      ETHERTYPE_IPV4,
      buildIpv4(
        IP_A,
        IP_B,
        IPPROTO_TCP,
        buildTcpSegment(IP_A, IP_B, {
          srcPort: 49152,
          dstPort: 80,
          seq: 1,
          ack: 0,
          flags: TCP_SYN,
          window: 65535,
          payload: new Uint8Array(0),
          mss: 1460,
        }),
      ),
    )
    expect(summarize(syn)).toEqual({ proto: 'TCP', text: '192.0.2.1:49152 → 192.0.2.2:80 [SYN] mss=1460' })

    const get = buildEth(
      MAC_B,
      MAC_A,
      ETHERTYPE_IPV4,
      buildIpv4(
        IP_A,
        IP_B,
        IPPROTO_TCP,
        buildTcpSegment(IP_A, IP_B, {
          srcPort: 49152,
          dstPort: 80,
          seq: 2,
          ack: 1,
          flags: 0x18,
          window: 65535,
          payload: new TextEncoder().encode('GET /index.html HTTP/1.1\r\nHost: x\r\n\r\n'),
        }),
      ),
    )
    expect(summarize(get)).toEqual({ proto: 'HTTP', text: '192.0.2.1:49152 → 192.0.2.2:80 GET /index.html HTTP/1.1' })
  })

  it('summarizes plain UDP', () => {
    const frame = buildEth(
      MAC_B,
      MAC_A,
      ETHERTYPE_IPV4,
      buildIpv4(IP_A, IP_B, IPPROTO_UDP, buildUdp(IP_A, IP_B, 5001, 5001, new Uint8Array(10))),
    )
    expect(summarize(frame)).toEqual({ proto: 'UDP', text: '192.0.2.1:5001 → 192.0.2.2:5001 len=10' })
  })

  it('degrades gracefully on junk', () => {
    expect(summarize(new Uint8Array(5)).proto).toBe('ETH')
  })
})
