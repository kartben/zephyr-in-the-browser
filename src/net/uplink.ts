/**
 * Guest Ethernet over a WebSocket: the browser side of the opt-in uplink to
 * a self-hosted gateway (docs/net-gateway.md). The wire speaks QEMU's
 * stream-netdev framing — every Ethernet frame prefixed with a u32
 * big-endian length — carried as a *byte stream*: WebSocket message
 * boundaries mean nothing (passt coalesces writes, tunnels may refragment),
 * so RX reassembles across messages. TX sends one message per frame, which
 * receivers must treat as an optimization, not a contract. The same framing
 * is what passt serves natively and what gvisor-tap-vsock's AcceptQemu
 * expects, so `c2w-net --listen-ws` works as a gateway unchanged.
 *
 * The sink mirrors NetStack's shape (onGuestFrame / tick / dispose) so
 * hostNet can hold either behind one seam. While the socket is not open the
 * guest's carrier is held down and its frames are dropped and counted — a
 * transparent bridge, not a store-and-forward queue.
 */

import { LanSniffer, type SniffState } from './sniff'

export type UplinkPhase = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

export const WIRE_HDR = 4
/** RING_MAX_FRAME: anything longer can never be written to the guest ring. */
export const MAX_DELIVER_FRAME = 1522
/** A length prefix beyond this is not a frame — the stream has desynced. */
export const MAX_WIRE_FRAME = 2048
const MIN_WIRE_FRAME = 14
const SEND_BUFFER_CAP = 1 << 20
const STABLE_MS = 5000
const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const

export class FramingError extends Error {}

const ETH_HEADER = 14
const ETHERTYPE_IPV4 = 0x0800
const IPV4_MIN_TOTAL = 20

/**
 * Drop Ethernet minimum-size padding from an outbound IPv4 frame. Guests pad
 * short frames to 60 bytes like the hardware their drivers model (the
 * Cortex-M3's stellaris MAC does it in silicon), but passt releases before
 * 2026_07_16 drop any IPv4 packet whose L2 payload is longer than its IP
 * datagram (fixed upstream in commit f072bc0). Every short TCP segment —
 * SYN, pure ACK, FIN — is exactly such a frame, so against an unfixed
 * gateway TCP dies silently while DNS and DHCP (always long enough) keep
 * working. Padding carries no information, so trim it for every gateway.
 */
export function trimEthernetPadding(frame: Uint8Array): Uint8Array {
  if (frame.length < ETH_HEADER + IPV4_MIN_TOTAL) return frame
  if (((frame[12] << 8) | frame[13]) !== ETHERTYPE_IPV4) return frame
  const total = (frame[16] << 8) | frame[17]
  if (total < IPV4_MIN_TOTAL || ETH_HEADER + total >= frame.length) return frame
  return frame.subarray(0, ETH_HEADER + total)
}

/**
 * Reassembles the length-prefixed stream out of WS binary chunks. State
 * persists across push() calls; a bad length prefix throws FramingError and
 * resets, because nothing downstream of a desync can be trusted.
 */
export class StreamFramer {
  private pending: Uint8Array | null = null

  push(chunk: Uint8Array): Uint8Array[] {
    let buf: Uint8Array
    if (this.pending === null || this.pending.length === 0) {
      buf = chunk
    } else {
      buf = new Uint8Array(this.pending.length + chunk.length)
      buf.set(this.pending, 0)
      buf.set(chunk, this.pending.length)
    }
    const out: Uint8Array[] = []
    let off = 0
    while (buf.length - off >= WIRE_HDR) {
      const len =
        ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
      if (len < MIN_WIRE_FRAME || len > MAX_WIRE_FRAME) {
        this.pending = null
        throw new FramingError(`bad frame length ${len}; stream desynced`)
      }
      if (buf.length - off - WIRE_HDR < len) break
      out.push(buf.slice(off + WIRE_HDR, off + WIRE_HDR + len))
      off += WIRE_HDR + len
    }
    this.pending = off < buf.length ? buf.slice(off) : null
    return out
  }

  reset(): void {
    this.pending = null
  }
}

/**
 * A gentle warning for the one transport rule browsers enforce: an https
 * page may open ws:// only toward loopback — and Safari not even there.
 */
export function mixedContentHint(url: string): string {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return ''
  if (!url.toLowerCase().startsWith('ws://')) return ''
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return ''
  }
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  return loopback
    ? 'Safari blocks ws:// even to localhost; use the wss:// tunnel URL there'
    : 'ws:// from an https page is blocked; use a wss:// tunnel URL'
}

export interface UplinkHooks {
  /** Gateway → guest: hostNet.deliverToGuest (impairments + RX ring). */
  deliverFrame(frame: Uint8Array): void
  /** The connected edge moved — re-derive carrier and snapshot now. */
  onPhaseChange(): void
  /** Counters or sniffed identity moved — a coalesced refresh is fine. */
  onChange(): void
}

export interface UplinkOptions {
  /** Test seam; defaults to the global WebSocket constructor. */
  wsFactory?: (url: string) => WebSocket
  backoffMs?: readonly number[]
}

let defaultWsFactory: ((url: string) => WebSocket) | null = null

/**
 * Test seam for sinks constructed without an explicit factory (hostNet's).
 * Pass null to restore the global WebSocket constructor.
 */
export function setDefaultWsFactoryForTests(factory: ((url: string) => WebSocket) | null): void {
  defaultWsFactory = factory
}

export interface UplinkCounters {
  /** Guest frames dropped while the socket was not open (or backpressured). */
  droppedTx: number
  /** Well-framed inbound frames too big for the guest ring — MTU misconfig. */
  oversizeRx: number
  /** Dial attempts since the last stable connection. */
  attempts: number
}

export class UplinkSink {
  readonly url: string
  phase: UplinkPhase = 'idle'
  detail = ''
  readonly counters: UplinkCounters = { droppedTx: 0, oversizeRx: 0, attempts: 0 }
  readonly sniffer = new LanSniffer()

  private readonly hooks: UplinkHooks
  private readonly wsFactory: (url: string) => WebSocket
  private readonly backoffMs: readonly number[]
  private readonly framer = new StreamFramer()
  private ws: WebSocket | null = null
  private disposed = false
  /** User pressed Disconnect: stay down, no auto-reconnect. */
  private stopped = false
  private backoffIdx = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private stableTimer: ReturnType<typeof setTimeout> | undefined

  constructor(url: string, hooks: UplinkHooks, opts: UplinkOptions = {}) {
    this.url = url
    this.hooks = hooks
    this.wsFactory =
      opts.wsFactory ?? ((u) => (defaultWsFactory ? defaultWsFactory(u) : new WebSocket(u)))
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  }

  get sniff(): SniffState {
    return this.sniffer.state
  }

  /** Dial (or redial) now; resets the backoff ladder and attempt counter. */
  connect(): void {
    if (this.disposed) return
    this.stopped = false
    this.backoffIdx = 0
    this.counters.attempts = 0
    this.clearTimers()
    this.closeSocket()
    this.open()
  }

  disconnect(): void {
    if (this.disposed) return
    this.stopped = true
    this.clearTimers()
    this.closeSocket()
    this.setPhase('closed', '')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    this.closeSocket()
  }

  /** Poll-loop compatibility with NetStack; the socket needs no ticking. */
  tick(): void {}

  onGuestFrame(frame: Uint8Array): void {
    if (this.disposed) return
    frame = trimEthernetPadding(frame)
    if (this.sniffer.onTx(frame)) this.hooks.onChange()
    const ws = this.ws
    if (this.phase !== 'connected' || !ws || ws.readyState !== 1 /* OPEN */) {
      this.counters.droppedTx += 1
      this.hooks.onChange()
      return
    }
    if (ws.bufferedAmount > SEND_BUFFER_CAP) {
      this.counters.droppedTx += 1
      this.hooks.onChange()
      return
    }
    // Fresh copy: prepends the length and detaches from the shared wasm heap
    // (a SAB-backed view could be overwritten before the socket serializes it).
    const out = new Uint8Array(WIRE_HDR + frame.length)
    out[0] = (frame.length >>> 24) & 0xff
    out[1] = (frame.length >>> 16) & 0xff
    out[2] = (frame.length >>> 8) & 0xff
    out[3] = frame.length & 0xff
    out.set(frame, WIRE_HDR)
    ws.send(out)
  }

  /* ------------------------------------------------------------ internals */

  private open(): void {
    if (this.disposed || this.stopped) return
    if (!/^wss?:\/\//i.test(this.url)) {
      // Retrying cannot fix the URL — no reconnect timer for these.
      this.setPhase('error', this.url ? 'not a ws:// or wss:// URL' : 'set a gateway URL')
      return
    }
    this.counters.attempts += 1
    let ws: WebSocket
    try {
      ws = this.wsFactory(this.url)
    } catch (error) {
      this.setPhase('error', error instanceof Error ? error.message : String(error))
      return
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    this.framer.reset()
    this.setPhase('connecting', mixedContentHint(this.url))
    // Stale-socket guard on every handler: a reconnect or dispose may have
    // replaced `this.ws` while the old socket's events were still queued.
    ws.onopen = () => {
      if (this.disposed || this.ws !== ws) return
      this.onOpen()
    }
    ws.onmessage = (ev) => {
      if (this.disposed || this.ws !== ws) return
      this.onMessage(ev)
    }
    ws.onclose = (ev) => {
      if (this.disposed || this.ws !== ws) return
      this.onClose(ev)
    }
    ws.onerror = () => {
      /* the close event carries what little the browser is allowed to say */
    }
  }

  private onOpen(): void {
    this.setPhase('connected', '')
    this.stableTimer = setTimeout(() => {
      this.backoffIdx = 0
      this.counters.attempts = 0
      this.hooks.onChange()
    }, STABLE_MS)
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') return // text frames are not in the protocol
    let frames: Uint8Array[]
    try {
      frames = this.framer.push(new Uint8Array(ev.data as ArrayBuffer))
    } catch (error) {
      this.closeSocket(4000)
      this.setPhase('error', error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    let countersMoved = false
    for (const frame of frames) {
      if (frame.length > MAX_DELIVER_FRAME) {
        this.counters.oversizeRx += 1
        countersMoved = true
        if (this.detail === '') {
          this.detail = `oversize frame (${frame.length} B); clamp the gateway MTU to 1500`
        }
      } else {
        if (this.sniffer.onRx(frame)) countersMoved = true
        this.hooks.deliverFrame(frame)
      }
    }
    if (countersMoved) this.hooks.onChange()
  }

  private onClose(ev: CloseEvent): void {
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.stableTimer = undefined
    this.ws = null
    if (this.stopped) {
      this.setPhase('closed', '')
      return
    }
    let detail: string
    if (ev.code === 4001) detail = 'gateway rejected the token (4001)'
    else if (ev.code === 4002) detail = 'gateway is full (4002)'
    else if (ev.code === 4003) detail = 'gateway backend failed (4003)'
    else if (ev.code === 1006 || ev.code === 1015) {
      detail = ['gateway unreachable', mixedContentHint(this.url)].filter(Boolean).join('; ')
    } else {
      detail = `connection closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`
    }
    this.setPhase('error', detail)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.stopped || this.reconnectTimer !== undefined) return
    const delay = this.backoffMs[Math.min(this.backoffIdx, this.backoffMs.length - 1)]
    this.backoffIdx = Math.min(this.backoffIdx + 1, this.backoffMs.length - 1)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }

  private setPhase(phase: UplinkPhase, detail: string): void {
    if (this.phase === phase && this.detail === detail) return
    this.phase = phase
    this.detail = detail
    this.hooks.onPhaseChange()
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    if (this.stableTimer !== undefined) clearTimeout(this.stableTimer)
    this.reconnectTimer = this.stableTimer = undefined
  }

  private closeSocket(code = 1000): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close(code)
    } catch {
      /* already closing */
    }
  }
}
