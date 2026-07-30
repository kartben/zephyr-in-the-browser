/**
 * Passive identity for uplink mode. With the page no longer playing DHCP
 * server, the panel's IP / gateway / DNS readouts come from watching the
 * guest's own traffic go by: the DHCP exchange for leased configs, ARP (or a
 * first routed datagram) for static ones. Pure header peeks over the
 * existing codecs — the sniffer never emits a frame, and stays O(1) per
 * frame with no allocation beyond the MAC copy.
 */

import { parseArp } from './arp'
import {
  DHCP_ACK,
  DHCP_CLIENT_PORT,
  DHCP_DISCOVER,
  DHCP_NAK,
  DHCP_OFFER,
  DHCP_SERVER_PORT,
  parseDhcp,
} from './dhcp'
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEth } from './ethernet'
import { IPPROTO_UDP, parseIpv4 } from './ipv4'
import { parseUdp } from './udp'
import type { DhcpState } from './stack'

export interface SniffState {
  guestMac: Uint8Array | null
  guestIp: number | null
  gatewayIp: number | null
  dnsIp: number | null
  dhcpState: DhcpState
}

function isNoiseMac(mac: Uint8Array): boolean {
  let zero = true
  let ones = true
  for (let i = 0; i < 6; i++) {
    if (mac[i] !== 0) zero = false
    if (mac[i] !== 0xff) ones = false
  }
  return zero || ones
}

function macEq(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false
  return true
}

export class LanSniffer {
  readonly state: SniffState = {
    guestMac: null,
    guestIp: null,
    gatewayIp: null,
    dnsIp: null,
    dhcpState: 'waiting',
  }

  /** Once the guest speaks DHCP, ARP/IP sightings stop implying "static". */
  private sawDhcpClient = false

  /** Guest → gateway. Returns true when the published state changed. */
  onTx(frame: Uint8Array): boolean {
    const eth = parseEth(frame)
    if (!eth) return false
    const s = this.state
    let changed = false

    if (!s.guestMac && !isNoiseMac(eth.src)) {
      s.guestMac = eth.src.slice()
      changed = true
    }

    if (eth.etherType === ETHERTYPE_ARP) {
      const arp = parseArp(eth.payload)
      if (arp && arp.senderIp !== 0 && !this.sawDhcpClient && s.dhcpState === 'waiting') {
        s.guestIp = arp.senderIp
        s.dhcpState = 'static'
        changed = true
      }
      return changed
    }

    if (eth.etherType !== ETHERTYPE_IPV4) return changed
    const ip = parseIpv4(eth.payload)
    if (!ip) return changed

    if (ip.proto === IPPROTO_UDP) {
      const udp = parseUdp(ip.payload)
      if (udp && udp.srcPort === DHCP_CLIENT_PORT && udp.dstPort === DHCP_SERVER_PORT) {
        const msg = parseDhcp(udp.payload)
        if (msg) {
          this.sawDhcpClient = true
          // A fresh Discover after bound/static = new lease cycle (carrier
          // bounce, gateway reconnect). Waiting/offered stay as they are.
          if (msg.msgType === DHCP_DISCOVER && s.dhcpState !== 'waiting' && s.dhcpState !== 'offered') {
            s.dhcpState = 'waiting'
            s.guestIp = null
            changed = true
          }
        }
        return changed
      }
    }

    if (ip.src !== 0 && !this.sawDhcpClient && s.dhcpState === 'waiting') {
      s.guestIp = ip.src
      s.dhcpState = 'static'
      changed = true
    }
    return changed
  }

  /** Gateway → guest. Returns true when the published state changed. */
  onRx(frame: Uint8Array): boolean {
    const eth = parseEth(frame)
    if (!eth || eth.etherType !== ETHERTYPE_IPV4) return false
    const ip = parseIpv4(eth.payload)
    if (!ip || ip.proto !== IPPROTO_UDP) return false
    const udp = parseUdp(ip.payload)
    if (!udp || udp.srcPort !== DHCP_SERVER_PORT || udp.dstPort !== DHCP_CLIENT_PORT) return false
    const msg = parseDhcp(udp.payload)
    if (!msg) return false
    const s = this.state
    if (s.guestMac && !macEq(msg.chaddr, s.guestMac)) return false

    if (msg.msgType === DHCP_OFFER) {
      if (s.dhcpState !== 'waiting') return false
      s.dhcpState = 'offered'
      return true
    }
    if (msg.msgType === DHCP_ACK) {
      let changed = s.dhcpState !== 'bound'
      s.dhcpState = 'bound'
      if (msg.yiaddr !== 0 && s.guestIp !== msg.yiaddr) {
        s.guestIp = msg.yiaddr
        changed = true
      }
      if (msg.router !== null && s.gatewayIp !== msg.router) {
        s.gatewayIp = msg.router
        changed = true
      }
      if (msg.dns !== null && s.dnsIp !== msg.dns) {
        s.dnsIp = msg.dns
        changed = true
      }
      return changed
    }
    if (msg.msgType === DHCP_NAK) {
      const changed = s.dhcpState !== 'waiting' || s.guestIp !== null
      s.dhcpState = 'waiting'
      s.guestIp = null
      return changed
    }
    return false
  }
}
