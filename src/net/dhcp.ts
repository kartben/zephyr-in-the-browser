/** DHCP over BOOTP (RFC 2131 / 2132) — server side only. */

import { concat, viewOf } from './bytes'

export const DHCP_SERVER_PORT = 67
export const DHCP_CLIENT_PORT = 68

export const DHCP_DISCOVER = 1
export const DHCP_OFFER = 2
export const DHCP_REQUEST = 3
export const DHCP_ACK = 5
export const DHCP_NAK = 6

const MAGIC_COOKIE = 0x63825363

const OPT_SUBNET_MASK = 1
const OPT_ROUTER = 3
const OPT_DNS = 6
const OPT_REQUESTED_IP = 50
const OPT_LEASE_TIME = 51
const OPT_MSG_TYPE = 53
const OPT_SERVER_ID = 54
const OPT_SNTP = 42
const OPT_END = 255

export interface DhcpMessage {
  op: number
  xid: number
  /** Client's current address, when it has one. */
  ciaddr: number
  /** "Your" address — what the server assigns. */
  yiaddr: number
  /** Client hardware (MAC) address. */
  chaddr: Uint8Array
  /** The client set the broadcast flag. */
  broadcast: boolean
  msgType: number | null
  requestedIp: number | null
  serverId: number | null
}

export function parseDhcp(payload: Uint8Array): DhcpMessage | null {
  if (payload.length < 240) return null
  const view = viewOf(payload)
  if (view.getUint32(236) !== MAGIC_COOKIE) return null
  // Ethernet hardware addresses only.
  if (payload[1] !== 1 || payload[2] !== 6) return null

  const msg: DhcpMessage = {
    op: payload[0],
    xid: view.getUint32(4),
    ciaddr: view.getUint32(12),
    yiaddr: view.getUint32(16),
    chaddr: payload.subarray(28, 34),
    broadcast: (view.getUint16(10) & 0x8000) !== 0,
    msgType: null,
    requestedIp: null,
    serverId: null,
  }

  let i = 240
  while (i < payload.length) {
    const opt = payload[i]
    if (opt === OPT_END) break
    if (opt === 0) {
      i += 1
      continue
    }
    if (i + 1 >= payload.length) break
    const len = payload[i + 1]
    if (i + 2 + len > payload.length) break
    if (opt === OPT_MSG_TYPE && len === 1) msg.msgType = payload[i + 2]
    if (opt === OPT_REQUESTED_IP && len === 4) msg.requestedIp = view.getUint32(i + 2)
    if (opt === OPT_SERVER_ID && len === 4) msg.serverId = view.getUint32(i + 2)
    i += 2 + len
  }
  return msg
}

export interface DhcpReplyFields {
  msgType: number
  xid: number
  chaddr: Uint8Array
  /** Assigned address; 0 for a NAK. */
  yiaddr: number
  serverId: number
  subnetMask: number
  router: number
  dns: number
  sntp: number
  leaseSecs: number
}

export function buildDhcpReply(reply: DhcpReplyFields): Uint8Array {
  const head = new Uint8Array(240)
  const view = viewOf(head)
  head[0] = 2 // BOOTREPLY
  head[1] = 1 // Ethernet
  head[2] = 6
  view.setUint32(4, reply.xid)
  view.setUint32(16, reply.yiaddr)
  head.set(reply.chaddr.subarray(0, 6), 28)
  view.setUint32(236, MAGIC_COOKIE)

  const opt = (code: number, ...bytes: number[]) => Uint8Array.from([code, bytes.length, ...bytes])
  const ip4 = (ip: number) => [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff]

  const options: Uint8Array[] = [opt(OPT_MSG_TYPE, reply.msgType), opt(OPT_SERVER_ID, ...ip4(reply.serverId))]
  if (reply.msgType !== DHCP_NAK) {
    options.push(
      opt(OPT_LEASE_TIME, ...ip4(reply.leaseSecs)),
      opt(OPT_SUBNET_MASK, ...ip4(reply.subnetMask)),
      opt(OPT_ROUTER, ...ip4(reply.router)),
      opt(OPT_DNS, ...ip4(reply.dns)),
      opt(OPT_SNTP, ...ip4(reply.sntp)),
    )
  }
  options.push(Uint8Array.of(OPT_END))
  return concat(head, ...options)
}

export function dhcpTypeName(msgType: number | null): string {
  switch (msgType) {
    case DHCP_DISCOVER:
      return 'Discover'
    case DHCP_OFFER:
      return 'Offer'
    case DHCP_REQUEST:
      return 'Request'
    case 4:
      return 'Decline'
    case DHCP_ACK:
      return 'ACK'
    case DHCP_NAK:
      return 'NAK'
    case 7:
      return 'Release'
    case 8:
      return 'Inform'
    default:
      return `type ${msgType}`
  }
}
