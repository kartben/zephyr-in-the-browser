import { describe, expect, it } from 'vitest'
import { ipFromString, macFromString, MAC_BROADCAST, viewOf } from './bytes'
import { buildArp, ARP_REQUEST } from './arp'
import { buildDhcpReply, DHCP_ACK, DHCP_DISCOVER, DHCP_NAK, DHCP_OFFER, DHCP_REQUEST } from './dhcp'
import { buildEth, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from './ethernet'
import { buildIpv4, IPPROTO_UDP } from './ipv4'
import { buildUdp } from './udp'
import { LanSniffer } from './sniff'

const GUEST_MAC = macFromString('02:00:00:00:00:01')!
const GW_MAC = macFromString('52:54:00:12:34:56')!
const GUEST_IP = ipFromString('172.17.0.5')!
const GW_IP = ipFromString('172.17.0.1')!
const DNS_IP = ipFromString('172.17.0.53')!

/** A minimal BOOTREQUEST with just the message-type option. */
function dhcpClient(msgType: number): Uint8Array {
  const out = new Uint8Array(240 + 4)
  const view = viewOf(out)
  out[0] = 1 // BOOTREQUEST
  out[1] = 1 // Ethernet
  out[2] = 6
  out.set(GUEST_MAC, 28)
  view.setUint32(236, 0x63825363)
  out.set([53, 1, msgType, 255], 240)
  return out
}

function txDhcp(msgType: number): Uint8Array {
  const udp = buildUdp(0, 0xffffffff, 68, 67, dhcpClient(msgType))
  return buildEth(MAC_BROADCAST, GUEST_MAC, ETHERTYPE_IPV4, buildIpv4(0, 0xffffffff, IPPROTO_UDP, udp))
}

function rxDhcp(msgType: number, chaddr = GUEST_MAC): Uint8Array {
  const payload = buildDhcpReply({
    msgType,
    xid: 0x1234,
    chaddr,
    yiaddr: msgType === DHCP_NAK ? 0 : GUEST_IP,
    serverId: GW_IP,
    subnetMask: ipFromString('255.255.0.0')!,
    router: GW_IP,
    dns: DNS_IP,
    sntp: GW_IP,
    leaseSecs: 600,
  })
  const udp = buildUdp(GW_IP, GUEST_IP, 67, 68, payload)
  return buildEth(GUEST_MAC, GW_MAC, ETHERTYPE_IPV4, buildIpv4(GW_IP, GUEST_IP, IPPROTO_UDP, udp))
}

describe('LanSniffer', () => {
  it('follows a full DHCP handshake to bound with addresses', () => {
    const sniffer = new LanSniffer()
    expect(sniffer.onTx(txDhcp(DHCP_DISCOVER))).toBe(true) // learns the MAC
    expect(sniffer.state.guestMac).toEqual(GUEST_MAC)
    expect(sniffer.state.dhcpState).toBe('waiting')

    expect(sniffer.onRx(rxDhcp(DHCP_OFFER))).toBe(true)
    expect(sniffer.state.dhcpState).toBe('offered')

    expect(sniffer.onTx(txDhcp(DHCP_REQUEST))).toBe(false)
    expect(sniffer.state.dhcpState).toBe('offered')

    expect(sniffer.onRx(rxDhcp(DHCP_ACK))).toBe(true)
    expect(sniffer.state).toMatchObject({
      dhcpState: 'bound',
      guestIp: GUEST_IP,
      gatewayIp: GW_IP,
      dnsIp: DNS_IP,
    })
  })

  it('a NAK falls back to waiting and clears the lease', () => {
    const sniffer = new LanSniffer()
    sniffer.onTx(txDhcp(DHCP_DISCOVER))
    sniffer.onRx(rxDhcp(DHCP_OFFER))
    sniffer.onRx(rxDhcp(DHCP_ACK))
    expect(sniffer.onRx(rxDhcp(DHCP_NAK))).toBe(true)
    expect(sniffer.state.dhcpState).toBe('waiting')
    expect(sniffer.state.guestIp).toBeNull()
  })

  it('ignores DHCP replies addressed to another MAC', () => {
    const sniffer = new LanSniffer()
    sniffer.onTx(txDhcp(DHCP_DISCOVER))
    expect(sniffer.onRx(rxDhcp(DHCP_ACK, macFromString('02:00:00:00:00:99')!))).toBe(false)
    expect(sniffer.state.dhcpState).toBe('waiting')
  })

  it('a fresh Discover after bound starts a new lease cycle', () => {
    const sniffer = new LanSniffer()
    sniffer.onTx(txDhcp(DHCP_DISCOVER))
    sniffer.onRx(rxDhcp(DHCP_OFFER))
    sniffer.onRx(rxDhcp(DHCP_ACK))
    expect(sniffer.onTx(txDhcp(DHCP_DISCOVER))).toBe(true)
    expect(sniffer.state.dhcpState).toBe('waiting')
    expect(sniffer.state.guestIp).toBeNull()
  })

  it('reads a static config from the guest ARP announcement', () => {
    const sniffer = new LanSniffer()
    const arp = buildArp({
      op: ARP_REQUEST,
      senderMac: GUEST_MAC,
      senderIp: GUEST_IP,
      targetMac: macFromString('00:00:00:00:00:00')!,
      targetIp: GUEST_IP,
    })
    expect(sniffer.onTx(buildEth(MAC_BROADCAST, GUEST_MAC, ETHERTYPE_ARP, arp))).toBe(true)
    expect(sniffer.state).toMatchObject({ dhcpState: 'static', guestIp: GUEST_IP })
  })

  it('a routed datagram implies static addressing when DHCP never happened', () => {
    const sniffer = new LanSniffer()
    const udp = buildUdp(GUEST_IP, GW_IP, 40000, 4242, Uint8Array.of(1, 2, 3))
    const frame = buildEth(GW_MAC, GUEST_MAC, ETHERTYPE_IPV4, buildIpv4(GUEST_IP, GW_IP, IPPROTO_UDP, udp))
    expect(sniffer.onTx(frame)).toBe(true)
    expect(sniffer.state).toMatchObject({ dhcpState: 'static', guestIp: GUEST_IP })
  })

  it('never lets ARP overwrite an address DHCP is negotiating', () => {
    const sniffer = new LanSniffer()
    sniffer.onTx(txDhcp(DHCP_DISCOVER))
    const arp = buildArp({
      op: ARP_REQUEST,
      senderMac: GUEST_MAC,
      senderIp: ipFromString('10.0.0.9')!,
      targetMac: macFromString('00:00:00:00:00:00')!,
      targetIp: GW_IP,
    })
    expect(sniffer.onTx(buildEth(MAC_BROADCAST, GUEST_MAC, ETHERTYPE_ARP, arp))).toBe(false)
    expect(sniffer.state.dhcpState).toBe('waiting')
    expect(sniffer.state.guestIp).toBeNull()
  })
})
