/**
 * Shared shape of the Bridge network sink (src/net/bridgeSink.ts): its phase,
 * the hooks hostNet hands it, and the outbound frame cleanup it applies.
 */

export type UplinkPhase = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

const ETH_HEADER = 14
const ETHERTYPE_IPV4 = 0x0800
const IPV4_MIN_TOTAL = 20

/**
 * Drop Ethernet minimum-size padding from an outbound IPv4 frame. Guests pad
 * short frames to 60 bytes like the hardware their drivers model (the
 * Cortex-M3's stellaris MAC does it in silicon), and a user-mode network
 * stack may drop an IPv4 packet whose L2 payload is longer than its IP
 * datagram (passt did, until commit f072bc0). Every short TCP segment (SYN,
 * pure ACK, FIN) is exactly such a frame. Padding carries no information, so
 * trim it before a frame leaves the page.
 */
export function trimEthernetPadding(frame: Uint8Array): Uint8Array {
  if (frame.length < ETH_HEADER + IPV4_MIN_TOTAL) return frame
  if (((frame[12] << 8) | frame[13]) !== ETHERTYPE_IPV4) return frame
  const total = (frame[16] << 8) | frame[17]
  if (total < IPV4_MIN_TOTAL || ETH_HEADER + total >= frame.length) return frame
  return frame.subarray(0, ETH_HEADER + total)
}

export interface UplinkHooks {
  /** Bridge → guest: hostNet.deliverToGuest (impairments + RX ring). */
  deliverFrame(frame: Uint8Array): void
  /** The connected edge moved — re-derive carrier and snapshot now. */
  onPhaseChange(): void
  /** Counters or sniffed identity moved — a coalesced refresh is fine. */
  onChange(): void
}
