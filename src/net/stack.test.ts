import { describe, expect, it } from 'vitest'
import { ipFromString, ipToString, macToString } from './bytes'
import { parseEth, ETHERTYPE_ARP } from './ethernet'
import { parseArp, ARP_REPLY } from './arp'
import { createLoopback } from './testing/loopback'

describe('NetStack', () => {
  it('completes a DHCP handshake and binds the lease', async () => {
    const lb = createLoopback()
    const ip = await lb.guest.dhcp()
    expect(ipToString(ip)).toBe('192.0.2.1')
    expect(lb.stack.dhcpState).toBe('bound')
    expect(lb.stack.guestIp).toBe(ip)
    expect(macToString(lb.stack.guestMac!)).toBe(macToString(lb.guest.mac))
    expect(lb.events).toContainEqual({ kind: 'guest-ip', ip, dhcpState: 'bound' })
  })

  it('stays silent for the address-conflict probe of its own lease', () => {
    const lb = createLoopback()
    const before = lb.framesToGuest.length
    // A DHCP client probing its offered address: sender 0.0.0.0, target lease.
    lb.guest.arpWhoHas('192.0.2.1')
    expect(lb.framesToGuest.length).toBe(before)
  })

  it('proxy-ARPs everything else, even off-subnet gateways', () => {
    const lb = createLoopback()
    lb.guest.configureStatic('10.0.2.15')
    lb.guest.arpWhoHas('10.0.2.2')
    const last = lb.framesToGuest.at(-1)!
    const eth = parseEth(last)!
    expect(eth.etherType).toBe(ETHERTYPE_ARP)
    const arp = parseArp(eth.payload)!
    expect(arp.op).toBe(ARP_REPLY)
    expect(ipToString(arp.senderIp)).toBe('10.0.2.2')
    expect(macToString(arp.senderMac)).toBe('52:55:0a:00:02:02')
    // And the guest's static address was learned.
    expect(lb.stack.dhcpState).toBe('static')
    expect(ipToString(lb.stack.guestIp!)).toBe('10.0.2.15')
  })

  it('answers ICMP echo for any destination', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    await expect(lb.guest.ping('203.0.113.77', 3)).resolves.toBeUndefined()
  })

  it('serves synthetic DNS answers offline, stably per name', async () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    const first = await lb.guest.resolveName('device.example')
    const again = await lb.guest.resolveName('device.example')
    expect(first).toBe(again)
    expect(ipToString(first)).toMatch(/^203\.0\.113\./)
    const internal = await lb.guest.resolveName('host.internal')
    expect(internal).toBe(lb.stack.gwIp)
  })

  it('uses DoH answers when fetch is available', async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('dns.google/resolve?name=zephyrproject.org')
      return new Response(JSON.stringify({ Answer: [{ type: 1, data: '140.211.169.8' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const lb = createLoopback({ fetchImpl })
    lb.guest.configureStatic('192.0.2.1')
    const ip = await lb.guest.resolveName('zephyrproject.org')
    expect(ipToString(ip)).toBe('140.211.169.8')
  })

  it('answers SNTP with the virtual clock', () => {
    const lb = createLoopback()
    lb.guest.configureStatic('192.0.2.1')
    const replies: Uint8Array[] = []
    lb.guest.udpListen(40001, (_src, payload) => {
      replies.push(payload)
    })
    const request = new Uint8Array(48)
    request[0] = (4 << 3) | 3
    lb.guest.sendUdp(40001, ipFromString('192.0.2.2')!, 123, request)
    expect(replies.length).toBe(1)
    expect(replies[0].length).toBe(48)
    expect(replies[0][0] & 0x07).toBe(4) // server mode
    const secs = new DataView(replies[0].buffer, replies[0].byteOffset).getUint32(40)
    expect(secs).toBe(Math.floor(lb.now() / 1000) + 2208988800)
  })
})
